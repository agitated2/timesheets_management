-- =============================================================
-- Migration v10: Office separation (RLS-based multi-tenancy)
--
-- Adds an `offices` table and scopes visibility of profiles, projects,
-- timesheets/entries, leave data and calendars to the offices a user
-- may see: their home office (`profiles.office_id`), any
-- `additional_office_ids`, or everything if `sees_all_offices` or `it`.
--
-- HIGHEST-RISK MIGRATION — the backfill and the policy changes ship in
-- one transaction. If the read-policy predicates landed before every
-- existing row had an office_id, every non-IT user would see an empty
-- app the moment this script committed.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

-- ── (a) Offices table + office_id columns ──────────────────────
CREATE TABLE IF NOT EXISTS public.offices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offices_name_lower ON public.offices(lower(name));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS office_id             UUID REFERENCES public.offices(id),
  ADD COLUMN IF NOT EXISTS additional_office_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sees_all_offices      BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id);

ALTER TABLE public.holiday_calendars
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_office ON public.holiday_calendars(office_id);

CREATE INDEX IF NOT EXISTS idx_profiles_office ON public.profiles(office_id);
CREATE INDEX IF NOT EXISTS idx_projects_office ON public.projects(office_id);

-- ---- SEED + BACKFILL BEFORE ANY POLICY CHANGE ----
-- Every row that exists today belongs to the Amman office. Referenced by
-- name (not "first created") so the migration is re-runnable and
-- unambiguous even if other offices already exist.
INSERT INTO public.offices (name)
SELECT 'Amman'
WHERE NOT EXISTS (SELECT 1 FROM public.offices WHERE lower(name) = 'amman');

-- Employees. This is what scopes timesheets, timesheet_entries, leave_requests
-- and leave_balances too — they all resolve office through employee_id.
UPDATE public.profiles
   SET office_id = (SELECT id FROM public.offices WHERE lower(name) = 'amman')
 WHERE office_id IS NULL;

-- Projects. This is what scopes project_stages and project_members.
UPDATE public.projects
   SET office_id = (SELECT id FROM public.offices WHERE lower(name) = 'amman')
 WHERE office_id IS NULL;

-- Tie the existing default calendar to Amman (weekends + public holidays carry over).
UPDATE public.holiday_calendars
   SET office_id = (SELECT id FROM public.offices WHERE lower(name) = 'amman')
 WHERE is_default AND office_id IS NULL;

-- Close the isolation hole: once every row is backfilled, an office becomes
-- mandatory. Without this, any future row created without an office_id would be
-- visible to EVERY user (see the `o IS NULL` safety valve in can_see_office).
ALTER TABLE public.profiles ALTER COLUMN office_id SET NOT NULL;
ALTER TABLE public.projects ALTER COLUMN office_id SET NOT NULL;

-- Verify before continuing — a non-zero count here aborts the whole
-- transaction, which is the desired outcome (a failed migration beats a
-- partial one).
DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM public.profiles WHERE office_id IS NULL;
  IF v_missing > 0 THEN RAISE EXCEPTION '% profiles still have no office_id', v_missing; END IF;
  SELECT COUNT(*) INTO v_missing FROM public.projects WHERE office_id IS NULL;
  IF v_missing > 0 THEN RAISE EXCEPTION '% projects still have no office_id', v_missing; END IF;
END $$;

ALTER TABLE public.offices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "offices_read" ON public.offices;
CREATE POLICY "offices_read" ON public.offices
  FOR SELECT USING (auth.uid() IS NOT NULL);
-- No direct INSERT/UPDATE policy — writes only via upsert_office() (SECURITY DEFINER).

-- ── (b) handle_new_user() must set office_id atomically ─────────
-- profiles.office_id is NOT NULL as of this migration, so the signup
-- trigger's bare INSERT would now violate that constraint unless the
-- office is supplied at creation time. create-user.js passes it through
-- auth user_metadata; this MUST land in the same INSERT as the row's
-- creation — there is no window to backfill it afterwards without
-- briefly reintroducing the "visible to everyone" NULL-office hole.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, office_id)
  VALUES (NEW.id, NEW.email, NULLIF(NEW.raw_user_meta_data->>'office_id', '')::UUID)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ── (c) Visibility helpers ───────────────────────────────────────
-- All offices the caller may READ. IT and sees_all_offices get everything.
-- STABLE matters: the planner evaluates the array once per statement, so
-- `= ANY(...)` in can_see_office costs about the same as plain equality.
CREATE OR REPLACE FUNCTION public.my_visible_office_ids()
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p.sees_all_offices OR public.my_has_role('it')
      THEN ARRAY(SELECT id FROM public.offices)
    ELSE ARRAY[p.office_id] || p.additional_office_ids
  END
  FROM public.profiles p WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.can_see_office(o UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o IS NULL OR o = ANY(public.my_visible_office_ids());
$$;

-- ── (d) Office predicates on read policies ──────────────────────
-- Appended to every non-"own" / non-"member" read policy on office-scoped
-- tables. *_read_own and the project-membership policies (an explicit,
-- individually-granted relationship, same spirit as *_read_own) are left
-- untouched — a user always sees their own rows and their own explicit
-- assignments. "*_manage" / FOR ALL policies for privileged roles
-- (projects_control, hr_manage_policies, hr_manage_calendar, it) are also
-- left untouched — this migration scopes READ visibility, not the write
-- authority those roles already hold globally.

-- ---- PROFILES ----
DROP POLICY IF EXISTS "profiles_read_for_manager_select" ON public.profiles;
CREATE POLICY "profiles_read_for_manager_select" ON public.profiles
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND ('manager' = ANY(roles) OR 'c_suite' = ANY(roles))
    AND public.can_see_office(office_id)
  );

DROP POLICY IF EXISTS "profiles_read_subordinates" ON public.profiles;
CREATE POLICY "profiles_read_subordinates" ON public.profiles
  FOR SELECT USING (auth.uid() = ANY(manager_ids) AND public.can_see_office(office_id));

DROP POLICY IF EXISTS "profiles_read_privileged" ON public.profiles;
CREATE POLICY "profiles_read_privileged" ON public.profiles
  FOR SELECT USING (
    (public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it'))
    AND public.can_see_office(office_id)
  );

DROP POLICY IF EXISTS "profiles_read_global_analytics" ON public.profiles;
CREATE POLICY "profiles_read_global_analytics" ON public.profiles
  FOR SELECT USING (public.my_has_role('global_analytics') AND public.can_see_office(office_id));

DROP POLICY IF EXISTS "profiles_read_hr_flags" ON public.profiles;
CREATE POLICY "profiles_read_hr_flags" ON public.profiles
  FOR SELECT USING (public.has_any_hr_flag() AND public.can_see_office(office_id));

-- ---- TIMESHEETS ----
DROP POLICY IF EXISTS "timesheets_read_manager" ON public.timesheets;
CREATE POLICY "timesheets_read_manager" ON public.timesheets
  FOR SELECT USING (
    (public.my_has_role('manager') OR public.my_has_role('c_suite'))
    AND public.i_manage(employee_id)
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

DROP POLICY IF EXISTS "timesheets_read_privileged" ON public.timesheets;
CREATE POLICY "timesheets_read_privileged" ON public.timesheets
  FOR SELECT USING (
    (public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

DROP POLICY IF EXISTS "timesheets_read_global_analytics" ON public.timesheets;
CREATE POLICY "timesheets_read_global_analytics" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('global_analytics')
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

DROP POLICY IF EXISTS "timesheets_read_team_analytics" ON public.timesheets;
CREATE POLICY "timesheets_read_team_analytics" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('team_analytics') AND public.i_manage(employee_id)
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

DROP POLICY IF EXISTS "timesheets_read_hr_view" ON public.timesheets;
CREATE POLICY "timesheets_read_hr_view" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('hr_view_timesheets')
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

-- ---- TIMESHEET_ENTRIES ----
DROP POLICY IF EXISTS "entries_read_manager" ON public.timesheet_entries;
CREATE POLICY "entries_read_manager" ON public.timesheet_entries
  FOR SELECT USING (
    (public.my_has_role('manager') OR public.my_has_role('c_suite'))
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.i_manage(t.employee_id) AND public.can_see_office(pr.office_id)
    )
  );

DROP POLICY IF EXISTS "entries_read_privileged" ON public.timesheet_entries;
CREATE POLICY "entries_read_privileged" ON public.timesheet_entries
  FOR SELECT USING (
    (public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it'))
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

DROP POLICY IF EXISTS "entries_read_global_analytics" ON public.timesheet_entries;
CREATE POLICY "entries_read_global_analytics" ON public.timesheet_entries
  FOR SELECT USING (
    public.my_has_role('global_analytics')
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

DROP POLICY IF EXISTS "entries_read_team_analytics" ON public.timesheet_entries;
CREATE POLICY "entries_read_team_analytics" ON public.timesheet_entries
  FOR SELECT USING (
    public.my_has_role('team_analytics')
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.i_manage(t.employee_id) AND public.can_see_office(pr.office_id)
    )
  );

DROP POLICY IF EXISTS "entries_read_hr_view" ON public.timesheet_entries;
CREATE POLICY "entries_read_hr_view" ON public.timesheet_entries
  FOR SELECT USING (
    public.my_has_role('hr_view_timesheets')
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

-- ---- PROJECTS / STAGES / MEMBERS ----
-- (projects_read_member / stages_read_member / members_read_own are an
--  explicit membership grant, not a general office-wide browse — left as-is.)
DROP POLICY IF EXISTS "projects_read_hr_flags" ON public.projects;
CREATE POLICY "projects_read_hr_flags" ON public.projects
  FOR SELECT USING (public.has_any_hr_flag() AND public.can_see_office(office_id));

DROP POLICY IF EXISTS "projects_read_analytics" ON public.projects;
CREATE POLICY "projects_read_analytics" ON public.projects
  FOR SELECT USING (
    (public.my_has_role('global_analytics') OR public.my_has_role('team_analytics'))
    AND public.can_see_office(office_id)
  );

DROP POLICY IF EXISTS "stages_read_hr_flags" ON public.project_stages;
CREATE POLICY "stages_read_hr_flags" ON public.project_stages
  FOR SELECT USING (
    public.has_any_hr_flag()
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND public.can_see_office(p.office_id))
  );

DROP POLICY IF EXISTS "stages_read_analytics" ON public.project_stages;
CREATE POLICY "stages_read_analytics" ON public.project_stages
  FOR SELECT USING (
    (public.my_has_role('global_analytics') OR public.my_has_role('team_analytics'))
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND public.can_see_office(p.office_id))
  );

DROP POLICY IF EXISTS "members_read_privileged" ON public.project_members;
CREATE POLICY "members_read_privileged" ON public.project_members
  FOR SELECT USING (
    public.has_any_hr_flag()
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND public.can_see_office(p.office_id))
  );

-- ---- LEAVE REQUESTS / BALANCES ----
DROP POLICY IF EXISTS "leave_req_read_manager" ON public.leave_requests;
CREATE POLICY "leave_req_read_manager" ON public.leave_requests
  FOR SELECT USING (
    public.i_manage(employee_id)
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

DROP POLICY IF EXISTS "leave_req_read_privileged" ON public.leave_requests;
CREATE POLICY "leave_req_read_privileged" ON public.leave_requests
  FOR SELECT USING (
    (public.has_any_hr_flag() OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

DROP POLICY IF EXISTS "leave_bal_read_privileged" ON public.leave_balances;
CREATE POLICY "leave_bal_read_privileged" ON public.leave_balances
  FOR SELECT USING (
    (public.has_any_hr_flag() OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

-- leave_cycle_grants is the audit trail behind leave_balances — same scoping.
DROP POLICY IF EXISTS "leave_cycle_grants_read_privileged" ON public.leave_cycle_grants;
CREATE POLICY "leave_cycle_grants_read_privileged" ON public.leave_cycle_grants
  FOR SELECT USING (
    (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

-- ---- CALENDARS / HOLIDAYS ----
-- calendar_assignments is deliberately left untouched (table, RLS, RPC) —
-- office scoping replaces it as the resolution path; see emp_calendar() below.
DROP POLICY IF EXISTS "cal_read" ON public.holiday_calendars;
CREATE POLICY "cal_read" ON public.holiday_calendars
  FOR SELECT USING (auth.uid() IS NOT NULL AND public.can_see_office(office_id));

DROP POLICY IF EXISTS "holidays_read" ON public.public_holidays;
CREATE POLICY "holidays_read" ON public.public_holidays
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.holiday_calendars hc WHERE hc.id = calendar_id AND public.can_see_office(hc.office_id))
  );

-- ── (e) Write paths ───────────────────────────────────────────
-- New projects take the creator's home office. Timesheets inherit
-- office scoping through employee_id — no change needed there.
CREATE OR REPLACE FUNCTION public.create_project(
  p_name TEXT, p_description TEXT, p_tracking_type project_tracking_type,
  p_start DATE, p_end DATE, p_total_hours NUMERIC
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID; v_office UUID;
BEGIN
  IF NOT public.can_manage_projects() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_tracking_type IS DISTINCT FROM 'date' THEN
    RAISE EXCEPTION 'Hour-tracked projects are no longer supported — use date tracking.';
  END IF;
  IF p_start IS NULL THEN RAISE EXCEPTION 'A start date is required for a date-tracked project.'; END IF;
  IF p_end IS NOT NULL AND p_end < p_start THEN RAISE EXCEPTION 'End date cannot be before start date.'; END IF;

  SELECT office_id INTO v_office FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.projects (name, description, tracking_type, start_date, end_date, total_hours, created_by, office_id)
  VALUES (p_name, NULLIF(trim(p_description), ''), 'date', p_start, p_end, NULL, auth.uid(), v_office)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── (f) Calendar ↔ office merge ──────────────────────────────
-- Resolve an employee's effective calendar via their HOME office, falling
-- back to the default calendar (e.g. an office created without pg_cron/
-- upsert_office ever having run for it yet). calendar_assignments is no
-- longer consulted — the table/RLS/RPC stay in place but unused.
CREATE OR REPLACE FUNCTION public.emp_calendar(emp UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT hc.id FROM public.holiday_calendars hc
       JOIN public.profiles p ON p.office_id = hc.office_id
      WHERE p.id = emp),
    (SELECT id FROM public.holiday_calendars WHERE is_default LIMIT 1)
  );
$$;

-- ── (g) Office management RPCs (IT only) ─────────────────────
-- Create or rename an office. New offices get their own weekend/holiday
-- calendar automatically (Fri/Sat default) so emp_calendar() always
-- resolves once an employee's home office is set.
CREATE OR REPLACE FUNCTION public.upsert_office(p_id UUID, p_name TEXT, p_is_active BOOLEAN)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.my_has_role('it') THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN RAISE EXCEPTION 'Office name is required.'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.offices (name, is_active)
    VALUES (trim(p_name), COALESCE(p_is_active, true))
    RETURNING id INTO v_id;

    INSERT INTO public.holiday_calendars (name, weekend_days, is_default, office_id)
    VALUES (trim(p_name), '{5,6}', false, v_id);
  ELSE
    UPDATE public.offices
      SET name = trim(p_name), is_active = COALESCE(p_is_active, is_active)
      WHERE id = p_id
      RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Office not found.'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- Bulk-assign home office / additional offices / sees_all_offices. p_home
-- is always applied; p_additional/p_sees_all are only touched when
-- non-NULL, so a bulk "move these employees to office X" call can pass
-- NULL for both without wiping out each employee's existing additional
-- offices or sees_all_offices flag.
CREATE OR REPLACE FUNCTION public.set_employee_offices(
  p_employees UUID[], p_home UUID, p_additional UUID[], p_sees_all BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.my_has_role('it') THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_home IS NULL THEN RAISE EXCEPTION 'A home office is required.'; END IF;

  UPDATE public.profiles
    SET office_id             = p_home,
        additional_office_ids = COALESCE(p_additional, additional_office_ids),
        sees_all_offices      = COALESCE(p_sees_all, sees_all_offices),
        updated_at            = NOW()
    WHERE id = ANY(p_employees);
END;
$$;

COMMIT;
