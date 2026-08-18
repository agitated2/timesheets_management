-- =============================================================
-- Migration v13: Daily timesheet reminder emails
--
-- Employees are expected to submit a timesheet every working day, but
-- nothing chases them. This migration adds the DB-side support for a
-- scheduled reminder job (see netlify/functions/daily-timesheet-reminders.js):
--
--   - offices.timezone (IANA name) + offices.timesheet_deadline: every
--     "today"/"late" decision in this app was previously either
--     browser-local (client) or UTC (CURRENT_DATE) with no reconciliation
--     between the two. A scheduled job makes that ambiguity load-bearing,
--     so each office now owns its own timezone and daily cut-off.
--   - reminder_log: at-most-once-per-recipient-per-day guarantee for the
--     job, via a plain UNIQUE index — no cron/pg_net infra required.
--   - timesheet_status_report(): one row per outstanding (missing/late)
--     working day, computed entirely in SQL against each office's own
--     local business date and deadline.
--   - reminder_recipients(): everyone whose OWN home-office local hour has
--     reached the send hour right now — send time is recipient-local,
--     independent of which office(s) their digest reports on.
--   - visible_office_ids_for(p_user): the office-visibility logic behind
--     my_visible_office_ids(), generalized to an arbitrary user so the job
--     can compute "what can this HR/manager recipient legitimately see"
--     the same way RLS already does for that user's own session.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

-- ── (a) Per-office timezone + daily submission deadline ────────────
ALTER TABLE public.offices
  ADD COLUMN IF NOT EXISTS timezone           TEXT NOT NULL DEFAULT 'Asia/Dubai',
  ADD COLUMN IF NOT EXISTS timesheet_deadline TIME NOT NULL DEFAULT '18:00';

-- Validate against pg_timezone_names rather than a CHECK constraint —
-- that view isn't IMMUTABLE, so Postgres won't allow it in a CHECK, and a
-- typo'd zone should fail loudly here rather than silently break every
-- "AT TIME ZONE" computation downstream.
CREATE OR REPLACE FUNCTION public.guard_office_timezone()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- OLD is NULL-valued (not an error) on INSERT, so IS DISTINCT FROM
  -- correctly covers both "new office" and "timezone actually changed"
  -- without a separate TG_OP branch.
  IF NEW.timezone IS DISTINCT FROM OLD.timezone THEN
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
      RAISE EXCEPTION 'Unknown timezone: %', NEW.timezone;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS offices_guard_timezone ON public.offices;
CREATE TRIGGER offices_guard_timezone BEFORE INSERT OR UPDATE ON public.offices
  FOR EACH ROW EXECUTE FUNCTION public.guard_office_timezone();

-- ── (b) app_settings: reminder job configuration ────────────────────
-- reminder_backlog_days defaults to 2, not the steady-state value of ~14
-- you'll likely want: the FIRST time this is enabled against a database
-- with real history, a 14-day backlog mails every outstanding day back to
-- go-live to every employee, manager and HR recipient in one run. Raise
-- it once you've confirmed a couple of clean runs.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS reminder_enabled      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminder_hour         INT     NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS reminder_backlog_days INT     NOT NULL DEFAULT 2;

-- ── (c) reminder_log — the job's entire idempotency guarantee ───────
-- One row per (recipient, their own local business date). RLS enabled
-- with NO policies at all: invisible to anon/authenticated, readable and
-- writable only by the service-role job, same treatment as any other
-- internal audit/attempt table in this schema.
CREATE TABLE IF NOT EXISTS public.reminder_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  business_date   DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'sent',
  error           TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial, not a plain unique index: a 'failed' attempt must NOT block a
-- retry, or one transient Graph error permanently suppresses that
-- recipient for the rest of the business day (nothing else re-claims the
-- row). A 'pending' or 'sent' row still blocks a duplicate claim, which is
-- the actual guarantee this index exists for.
DROP INDEX IF EXISTS public.idx_reminder_log_recipient_date;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_log_recipient_date
  ON public.reminder_log (recipient_id, business_date) WHERE status <> 'failed';

ALTER TABLE public.reminder_log ENABLE ROW LEVEL SECURITY;

-- ── (d) Office-visibility, generalized to an arbitrary user ─────────
-- Extracted from my_visible_office_ids() so the job can ask "what can
-- THIS recipient see" the same way RLS already answers it for auth.uid() —
-- duplicating the sees_all_offices / additional_office_ids / IT rules
-- here and in my_visible_office_ids() is exactly how the two would drift
-- apart. The IT check mirrors my_has_role()'s own roles-array-with-legacy-
-- role-column fallback, since my_has_role() itself is hardcoded to
-- auth.uid() and can't be called for an arbitrary user.
CREATE OR REPLACE FUNCTION public.visible_office_ids_for(p_user UUID)
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p.sees_all_offices
      OR (CASE WHEN cardinality(p.roles) > 0 THEN 'it' = ANY(p.roles) ELSE p.role = 'it' END)
      THEN ARRAY(SELECT id FROM public.offices)
    ELSE ARRAY[p.office_id] || p.additional_office_ids
  END
  FROM public.profiles p WHERE p.id = p_user;
$$;

CREATE OR REPLACE FUNCTION public.my_visible_office_ids()
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.visible_office_ids_for(auth.uid());
$$;

-- ── (e) The backlog itself ───────────────────────────────────────────
-- One row per PROBLEM day (state 'missing' or 'late') across every active
-- office, each judged against that office's own local business date and
-- deadline. 'missing' rows span the whole backlog window so a persistent
-- gap stays visible; 'late' rows are returned only for business_date
-- itself — otherwise one 18:30 submission would haunt a manager's table
-- every morning for a fortnight and train everyone to ignore the email.
CREATE OR REPLACE FUNCTION public.timesheet_status_report(p_backlog_days INT DEFAULT 14)
RETURNS TABLE (
  employee_id   UUID,
  full_name     TEXT,
  email         TEXT,
  office_id     UUID,
  office_name   TEXT,
  manager_ids   UUID[],
  business_date DATE,
  state         TEXT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH windows AS (
    SELECT o.id AS office_id, o.name AS office_name, o.timezone, o.timesheet_deadline,
           ((now() AT TIME ZONE o.timezone)::date - 1) AS business_date
    FROM public.offices o
    WHERE o.is_active
  ),
  candidate_days AS (
    SELECT p.id AS employee_id, p.full_name, p.email, p.office_id,
           w.office_name, p.manager_ids, w.timezone, w.timesheet_deadline, w.business_date,
           gs.d::date AS d
    FROM public.profiles p
    JOIN windows w ON w.office_id = p.office_id
    CROSS JOIN LATERAL generate_series(
      w.business_date - p_backlog_days, w.business_date, INTERVAL '1 day'
    ) AS gs(d)
    WHERE p.onboarding_complete
      AND p.joining_date IS NOT NULL
      AND p.joining_date <= gs.d::date
  ),
  problem_days AS (
    SELECT cd.*,
      (SELECT t.created_at FROM public.timesheets t
        WHERE t.employee_id = cd.employee_id AND t.date = cd.d
          AND t.status IN ('pending', 'approved')
        LIMIT 1) AS live_created_at
    FROM candidate_days cd
    WHERE public.is_working_day(cd.employee_id, cd.d)
      -- Only a full-day approved leave excuses the day — someone on two
      -- hours' hourly leave still worked the rest and still owes a sheet.
      AND NOT EXISTS (
        SELECT 1 FROM public.leave_requests lr
        WHERE lr.employee_id = cd.employee_id
          AND lr.status = 'approved' AND lr.revoked_at IS NULL
          AND lr.unit = 'daily'
          AND cd.d BETWEEN lr.start_date AND lr.end_date
      )
  )
  SELECT employee_id, full_name, email, office_id, office_name, manager_ids, d, 'missing'
  FROM problem_days
  WHERE live_created_at IS NULL

  UNION ALL

  SELECT employee_id, full_name, email, office_id, office_name, manager_ids, d, 'late'
  FROM problem_days
  WHERE live_created_at IS NOT NULL
    AND d = business_date
    AND (live_created_at AT TIME ZONE timezone) > (d + timesheet_deadline);
$$;

-- ── (f) Who's due a mail right now ───────────────────────────────────
-- Send time is the RECIPIENT's own home-office local hour — not the hour
-- of whichever office(s) their digest happens to cover. An office-centric
-- job would mail a New-York-based HR user their Dubai section at 01:00
-- EDT, and send a second, separate email per office. One row per person.
CREATE OR REPLACE FUNCTION public.reminder_recipients(p_reminder_hour INT DEFAULT 9)
RETURNS TABLE (
  user_id             UUID,
  email               TEXT,
  full_name           TEXT,
  home_office_id      UUID,
  local_business_date DATE,
  visible_office_ids  UUID[],
  is_hr               BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.email, p.full_name, p.office_id,
         ((now() AT TIME ZONE o.timezone)::date - 1),
         public.visible_office_ids_for(p.id),
         -- Same roles-array-with-legacy-role-column fallback as
         -- my_has_role() — an HR user still on the legacy single `role`
         -- column (never migrated onto the `roles` array) otherwise gets
         -- silently excluded from every HR digest.
         ((cardinality(p.roles) > 0 AND 'hr_view_timesheets' = ANY(p.roles))
           OR (cardinality(p.roles) = 0 AND p.role = 'hr_view_timesheets'))
  FROM public.profiles p
  JOIN public.offices o ON o.id = p.office_id
  WHERE o.is_active
    AND EXTRACT(hour FROM (now() AT TIME ZONE o.timezone)) >= p_reminder_hour;
$$;

-- Both return cross-employee, cross-office data assembled specifically
-- for the service-role job. CREATE FUNCTION grants EXECUTE to PUBLIC by
-- default, and Postgres privilege checks are additive across direct
-- grants, role membership AND PUBLIC — revoking from anon/authenticated
-- alone leaves the PUBLIC grant standing, so ANY authenticated user could
-- call these via PostgREST RPC and read every employee's name, email,
-- office and attendance gaps. Must revoke from PUBLIC itself; service_role
-- bypasses grants entirely, so the job is unaffected.
REVOKE EXECUTE ON FUNCTION public.timesheet_status_report(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reminder_recipients(INT)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.visible_office_ids_for(UUID) FROM PUBLIC;

-- ── (g) upsert_office gains timezone + deadline ─────────────────────
-- Changing an RPC's argument count via CREATE OR REPLACE doesn't replace
-- a differently-arity overload — PostgREST would see both the old 3-arg
-- and new 5-arg versions and refuse ambiguous calls (PGRST203). Drop the
-- old signature explicitly first.
DROP FUNCTION IF EXISTS public.upsert_office(UUID, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.upsert_office(
  p_id UUID, p_name TEXT, p_is_active BOOLEAN,
  p_timezone TEXT DEFAULT NULL, p_deadline TIME DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.my_has_role('it') THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN RAISE EXCEPTION 'Office name is required.'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.offices (name, is_active, timezone, timesheet_deadline)
    VALUES (trim(p_name), COALESCE(p_is_active, true), COALESCE(p_timezone, 'Asia/Dubai'), COALESCE(p_deadline, '18:00'))
    RETURNING id INTO v_id;

    INSERT INTO public.holiday_calendars (name, weekend_days, is_default, office_id)
    VALUES (trim(p_name), '{5,6}', false, v_id);
  ELSE
    UPDATE public.offices
      SET name = trim(p_name),
          is_active = COALESCE(p_is_active, is_active),
          timezone = COALESCE(p_timezone, timezone),
          timesheet_deadline = COALESCE(p_deadline, timesheet_deadline)
      WHERE id = p_id
      RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Office not found.'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- ── (h) Composite index backing timesheet_status_report() ──────────
-- problem_days' correlated subquery does one
-- `WHERE employee_id = ... AND date = ...` lookup per employee-day in the
-- backlog window (headcount × backlog_days per run). Only single-column
-- indexes on employee_id and date existed before this; a composite index
-- lets Postgres satisfy that lookup directly instead of intersecting two
-- scans.
CREATE INDEX IF NOT EXISTS idx_timesheets_employee_date
  ON public.timesheets (employee_id, date);

-- ── (i) reminder_log_recent — lets an IT admin see run history ──────
-- reminder_log has RLS enabled with NO policies (by design — see above),
-- so it's invisible even to IT through PostgREST directly. This wraps it
-- in a SECURITY DEFINER function gated by an internal my_has_role('it')
-- check, the same authorization pattern upsert_office already uses above
-- — no REVOKE needed, since the check inside the function is what actually
-- gates access, not the grant.
CREATE OR REPLACE FUNCTION public.reminder_log_recent(p_hours INT DEFAULT 48)
RETURNS SETOF public.reminder_log
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.my_has_role('it') THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  RETURN QUERY
    SELECT * FROM public.reminder_log
    WHERE sent_at > NOW() - (GREATEST(p_hours, 1) || ' hours')::INTERVAL
    ORDER BY sent_at DESC
    LIMIT 500;
END;
$$;

-- ── Verify before continuing ─────────────────────────────────────────
DO $$
DECLARE v_bad INT;
BEGIN
  SELECT COUNT(*) INTO v_bad FROM public.offices
    WHERE timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = offices.timezone);
  IF v_bad > 0 THEN RAISE EXCEPTION '% offices have a missing/invalid timezone', v_bad; END IF;

  SELECT COUNT(*) INTO v_bad FROM public.offices WHERE timesheet_deadline IS NULL;
  IF v_bad > 0 THEN RAISE EXCEPTION '% offices have no timesheet_deadline', v_bad; END IF;
END $$;

COMMIT;
