-- =============================================================
-- Migration v11: Per-office leave categories & policies
--
-- Leave categories (Annual, Sick, Unpaid, …) and their day-allowance /
-- rollover policies were the last globally-shared piece of the office
-- model introduced in migration_v10 — every office saw the same category
-- list and numbers. This migration makes categories per-office:
--
--   - leave_categories gains office_id NOT NULL. leave_policies is left
--     structurally UNCHANGED — category_id stays UNIQUE, so a policy's
--     office is resolved THROUGH its category. A policy can never point
--     at a different office than its category.
--   - New offices start EMPTY (no cloned categories) — HR configures them.
--   - Moving an employee between offices remaps their balances + cycle
--     grants by category name, preserving REMAINING days (allowance minus
--     what they've already used this cycle). Historical leave_requests
--     stay pointed at the old office's category — that IS where the leave
--     was taken.
--   - The "Run leave cycle now" sweep (p_employee = NULL) becomes IT-only
--     and moves to the IT Panel; the RPC signature is unchanged.
--
-- HIGH-RISK MIGRATION, same shape as v10: backfill fully before any RLS or
-- RPC change, verify with an aborting check, one transaction.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

-- ── (a) Column + index swap (global name → per-office name) ───────
ALTER TABLE public.leave_categories
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id);

-- Must drop the global index BEFORE the clone below — cloning "Annual
-- Leave" into a second office is exactly the duplicate this index forbids.
DROP INDEX IF EXISTS public.idx_leave_categories_name_lower;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_categories_office_name_lower
  ON public.leave_categories(office_id, lower(name));

-- Nothing indexed this FK before; the remap queries below and
-- leave_balance_summary.used both scan leave_requests by category_id.
CREATE INDEX IF NOT EXISTS idx_leave_requests_category ON public.leave_requests(category_id);

-- ── (b) Backfill: seed office → clone into every other office ─────
DO $$
DECLARE
  v_seed UUID;
  v_cats INT;
BEGIN
  SELECT COUNT(*) INTO v_cats FROM public.leave_categories;

  -- The office every pre-v11 category belongs to. migration_v10 seeded
  -- 'Amman' and backfilled every profile/project to it, so that's the
  -- answer by construction. Fallbacks only matter if it was renamed since.
  SELECT id INTO v_seed FROM public.offices WHERE lower(name) = 'amman';
  IF v_seed IS NULL THEN
    SELECT p.office_id INTO v_seed FROM public.profiles p
     WHERE p.office_id IS NOT NULL
     GROUP BY p.office_id ORDER BY COUNT(*) DESC, p.office_id LIMIT 1;
  END IF;
  IF v_seed IS NULL THEN
    SELECT id INTO v_seed FROM public.offices ORDER BY created_at, id LIMIT 1;
  END IF;
  IF v_seed IS NULL AND v_cats > 0 THEN
    RAISE EXCEPTION 'No office exists to own the % existing leave categories — run migration_v10 first.', v_cats;
  END IF;

  -- 1. Existing categories belong to the seed office.
  UPDATE public.leave_categories SET office_id = v_seed WHERE office_id IS NULL;

  -- 2. Clone the seed set into every OTHER office that already exists —
  --    a ONE-TIME backfill, not ongoing policy. Offices created from here
  --    on start empty (upsert_office deliberately does not clone). Offices
  --    that exist today already have employees holding balances and
  --    requests against these exact categories, so they must not lose them.
  --    The SELECT is a statement-start snapshot, so rows this INSERT adds
  --    are invisible to it — no self-amplification.
  INSERT INTO public.leave_categories (name, is_paid, is_active, created_by, office_id)
  SELECT c.name, c.is_paid, c.is_active, c.created_by, o.id
    FROM public.offices o
    CROSS JOIN public.leave_categories c
   WHERE c.office_id = v_seed
     AND o.id <> v_seed
     AND NOT EXISTS (
       SELECT 1 FROM public.leave_categories x
        WHERE x.office_id = o.id AND lower(x.name) = lower(c.name));

  -- 3. Clone their POLICIES too. leave_policies.category_id is UNIQUE, so a
  --    cloned category starts with no policy — without this, run_leave_cycle
  --    silently stops granting for every non-seed office the moment this
  --    commits. Cloning preserves today's behaviour exactly.
  INSERT INTO public.leave_policies
    (category_id, default_days_per_year, rollover_enabled, rollover_cap,
     rollover_expiry_months, prorate_first_year, updated_by)
  SELECT tgt.id, sp.default_days_per_year, sp.rollover_enabled, sp.rollover_cap,
         sp.rollover_expiry_months, sp.prorate_first_year, sp.updated_by
    FROM public.leave_policies sp
    JOIN public.leave_categories src ON src.id = sp.category_id AND src.office_id = v_seed
    JOIN public.leave_categories tgt ON tgt.office_id <> v_seed
                                     AND lower(tgt.name) = lower(src.name)
  ON CONFLICT (category_id) DO NOTHING;

  -- 4. Anyone already moved off the seed office (via set_employee_offices)
  --    before this migration ran still holds balances/grants/requests
  --    against the seed office's category rows. Repoint them at their own
  --    office's clone, matched by name. This is a straight re-home (the
  --    category is unchanged, just now represented by two rows instead of
  --    one) — NOT the "preserve remaining" logic set_employee_offices uses
  --    for genuine future moves. Every statement here is a no-op on a
  --    single-office database, and a no-op on re-run.

  -- 4a. leave_balances — UNIQUE(employee_id, category_id). Collision (rare:
  --     employee already has a row on the destination category) keeps the
  --     greater allowance, drops the stale row, then repoints the rest.
  UPDATE public.leave_balances dst
     SET allowance = GREATEST(dst.allowance, src.allowance), updated_at = NOW()
    FROM public.leave_balances src
    JOIN public.profiles p          ON p.id  = src.employee_id
    JOIN public.leave_categories sc ON sc.id = src.category_id
    JOIN public.leave_categories dc ON dc.office_id = p.office_id
                                    AND lower(dc.name) = lower(sc.name)
   WHERE sc.office_id <> p.office_id
     AND dst.employee_id = src.employee_id
     AND dst.category_id = dc.id;

  DELETE FROM public.leave_balances src
   USING public.profiles p, public.leave_categories sc, public.leave_categories dc
   WHERE p.id  = src.employee_id
     AND sc.id = src.category_id AND sc.office_id <> p.office_id
     AND dc.office_id = p.office_id AND lower(dc.name) = lower(sc.name)
     AND EXISTS (SELECT 1 FROM public.leave_balances d
                  WHERE d.employee_id = src.employee_id AND d.category_id = dc.id);

  UPDATE public.leave_balances src
     SET category_id = dc.id, updated_at = NOW()
    FROM public.profiles p, public.leave_categories sc, public.leave_categories dc
   WHERE p.id  = src.employee_id
     AND sc.id = src.category_id AND sc.office_id <> p.office_id
     AND dc.office_id = p.office_id AND lower(dc.name) = lower(sc.name);

  -- 4b. leave_cycle_grants — UNIQUE(employee_id, category_id, cycle_start).
  --     This is not cosmetic: the grant row is run_leave_cycle()'s
  --     idempotency guard. Leave it behind and the next login re-grants the
  --     current cycle against the new category, stomping the balance 4a
  --     just carried over with a bare default_days_per_year.
  DELETE FROM public.leave_cycle_grants src
   USING public.profiles p, public.leave_categories sc, public.leave_categories dc
   WHERE p.id  = src.employee_id
     AND sc.id = src.category_id AND sc.office_id <> p.office_id
     AND dc.office_id = p.office_id AND lower(dc.name) = lower(sc.name)
     AND EXISTS (SELECT 1 FROM public.leave_cycle_grants d
                  WHERE d.employee_id = src.employee_id AND d.category_id = dc.id
                    AND d.cycle_start = src.cycle_start);

  UPDATE public.leave_cycle_grants src
     SET category_id = dc.id
    FROM public.profiles p, public.leave_categories sc, public.leave_categories dc
   WHERE p.id  = src.employee_id
     AND sc.id = src.category_id AND sc.office_id <> p.office_id
     AND dc.office_id = p.office_id AND lower(dc.name) = lower(sc.name);

  -- 4c. leave_requests. Unlike a genuine future move (where history stays
  --     put), this backfill is re-homing one global category into per-office
  --     copies — the request itself hasn't moved offices, only which row
  --     represents its category has. Leaving it behind would make `used`
  --     read 0 against the new balance and hand back already-taken days.
  UPDATE public.leave_requests src
     SET category_id = dc.id
    FROM public.profiles p, public.leave_categories sc, public.leave_categories dc
   WHERE p.id  = src.employee_id
     AND sc.id = src.category_id AND sc.office_id <> p.office_id
     AND dc.office_id = p.office_id AND lower(dc.name) = lower(sc.name);
END $$;

-- Close the isolation hole: an officeless category would be visible to
-- every user (see the `o IS NULL` safety valve in can_see_office) and
-- assignable to anyone.
ALTER TABLE public.leave_categories ALTER COLUMN office_id SET NOT NULL;

-- Verify before continuing — a non-zero count aborts the whole transaction,
-- which is the desired outcome (a failed migration beats a partial one).
DO $$
DECLARE v_bad INT;
BEGIN
  SELECT COUNT(*) INTO v_bad FROM public.leave_categories WHERE office_id IS NULL;
  IF v_bad > 0 THEN RAISE EXCEPTION '% leave categories still have no office_id', v_bad; END IF;

  SELECT COUNT(*) INTO v_bad
    FROM public.leave_balances lb
    JOIN public.profiles p         ON p.id = lb.employee_id
    JOIN public.leave_categories c ON c.id = lb.category_id
   WHERE c.office_id <> p.office_id;
  IF v_bad > 0 THEN RAISE EXCEPTION '% leave_balances rows point at a category outside the employee office', v_bad; END IF;

  SELECT COUNT(*) INTO v_bad
    FROM public.leave_cycle_grants g
    JOIN public.profiles p         ON p.id = g.employee_id
    JOIN public.leave_categories c ON c.id = g.category_id
   WHERE c.office_id <> p.office_id;
  IF v_bad > 0 THEN RAISE EXCEPTION '% leave_cycle_grants rows point at a category outside the employee office', v_bad; END IF;

  SELECT COUNT(*) INTO v_bad
    FROM public.leave_requests lr
    JOIN public.profiles p         ON p.id = lr.employee_id
    JOIN public.leave_categories c ON c.id = lr.category_id
   WHERE c.office_id <> p.office_id;
  IF v_bad > 0 THEN RAISE EXCEPTION '% leave_requests rows point at a category outside the employee office', v_bad; END IF;
END $$;

-- ── (c) Helper + write-path safety net ─────────────────────────────
-- Caller's home office — same STABLE/SECURITY DEFINER shape as
-- my_visible_office_ids().
CREATE OR REPLACE FUNCTION public.my_office_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT office_id FROM public.profiles WHERE id = auth.uid();
$$;

-- HRPolicies.jsx writes categories via a direct client INSERT (no RPC).
-- This default is a safety net so an un-updated client lands the new
-- category in the creator's own office rather than hard-failing on
-- NOT NULL — the HR UI still sends office_id explicitly (a multi-office
-- admin must be able to create a category for an office that isn't theirs).
ALTER TABLE public.leave_categories ALTER COLUMN office_id SET DEFAULT public.my_office_id();

-- ── (d) RLS ──────────────────────────────────────────────────────
-- leave_cat_manage is FOR ALL, so its USING clause doubles as a SELECT
-- policy — office-scoping only leave_cat_read would leave HR/IT with
-- unrestricted global read via that OR.
DROP POLICY IF EXISTS "leave_cat_read"            ON public.leave_categories;
DROP POLICY IF EXISTS "leave_cat_read_referenced" ON public.leave_categories;
DROP POLICY IF EXISTS "leave_cat_manage"          ON public.leave_categories;

CREATE POLICY "leave_cat_read" ON public.leave_categories
  FOR SELECT USING (auth.uid() IS NOT NULL AND public.can_see_office(office_id));

-- History escape hatch: an employee moved between offices keeps old
-- requests (and possibly a stray balance) pointed at a category outside
-- their current office. Without this, those rows render with a blank
-- category name and leave_balance_summary (a security_invoker view that
-- JOINs categories) drops them entirely. The sub-selects are themselves
-- RLS-checked against leave_requests/leave_balances, so this grants no
-- visibility the caller doesn't already have, and neither of those
-- tables' policies reference leave_categories, so there's no recursion.
CREATE POLICY "leave_cat_read_referenced" ON public.leave_categories
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (
      EXISTS (SELECT 1 FROM public.leave_requests lr WHERE lr.category_id = leave_categories.id)
      OR EXISTS (SELECT 1 FROM public.leave_balances lb WHERE lb.category_id = leave_categories.id)
    )
  );

-- Writes stay a direct client INSERT/UPDATE (no category RPC), so the
-- office boundary lives in WITH CHECK. office_id IS NOT NULL is redundant
-- given the column constraint but documents intent and survives a future
-- ALTER, since can_see_office(NULL) is deliberately TRUE.
CREATE POLICY "leave_cat_manage" ON public.leave_categories
  FOR ALL
  USING (
    (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
    AND public.can_see_office(office_id)
  )
  WITH CHECK (
    (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
    AND office_id IS NOT NULL
    AND public.can_see_office(office_id)
  );

-- leave_policies_read: office-scoped through the category (leave_policies
-- itself has no office_id — its office is derived).
DROP POLICY IF EXISTS "leave_policies_read" ON public.leave_policies;
CREATE POLICY "leave_policies_read" ON public.leave_policies
  FOR SELECT USING (
    (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
    AND EXISTS (
      SELECT 1 FROM public.leave_categories c
       WHERE c.id = category_id AND public.can_see_office(c.office_id)
    )
  );

-- ── (e) RPCs ─────────────────────────────────────────────────────
-- All SECURITY DEFINER — RLS is bypassed inside every body below, so each
-- office check here is the only check there is. Existence is checked
-- BEFORE visibility throughout: a missing row yields NULL, and
-- can_see_office(NULL) returns TRUE by design — reverse the order and
-- "category does not exist" silently becomes "allowed".

-- Validate the category before inserting: must exist, be active, and
-- belong to the submitter's HOME office. Strict home office —
-- additional_office_ids / sees_all_offices grant administrative
-- visibility, not the right to book another office's leave.
CREATE OR REPLACE FUNCTION public.submit_leave_request(
  p_category UUID, p_unit leave_unit, p_start DATE, p_end DATE,
  p_start_time TIME, p_end_time TIME, p_reason TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp UUID := auth.uid();
  v_office     UUID;
  v_cat_office UUID;
  v_cat_active BOOLEAN;
  v_has_mgr BOOLEAN;
  v_status leave_request_status;
  v_days NUMERIC;
  v_name TEXT;
  v_id UUID;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT office_id INTO v_office FROM public.profiles WHERE id = v_emp;

  SELECT office_id, is_active INTO v_cat_office, v_cat_active
    FROM public.leave_categories WHERE id = p_category;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown leave category.'; END IF;
  IF NOT v_cat_active THEN RAISE EXCEPTION 'That leave category is no longer available.'; END IF;
  IF v_cat_office IS DISTINCT FROM v_office THEN
    RAISE EXCEPTION 'That leave category does not belong to your office.';
  END IF;

  IF p_unit = 'hourly' THEN
    p_end := p_start;
    IF p_start_time IS NULL OR p_end_time IS NULL OR p_end_time <= p_start_time THEN
      RAISE EXCEPTION 'Hourly leave needs a valid start and end time on a single date.';
    END IF;
    v_days := CASE WHEN public.is_working_day(v_emp, p_start)
                   THEN round(EXTRACT(EPOCH FROM (p_end_time - p_start_time)) / 3600.0 / 8.0, 2)
                   ELSE 0 END;
  ELSE
    IF p_end < p_start THEN RAISE EXCEPTION 'End date cannot be before start date.'; END IF;
    v_days := public.leave_working_days(v_emp, p_start, p_end);
  END IF;

  SELECT cardinality(manager_ids) > 0, COALESCE(full_name, email)
    INTO v_has_mgr, v_name FROM public.profiles WHERE id = v_emp;
  v_status := CASE WHEN v_has_mgr THEN 'pending_manager' ELSE 'pending_hr' END;

  INSERT INTO public.leave_requests (
    employee_id, category_id, unit, start_date, end_date, start_time, end_time, reason, status, days_count
  ) VALUES (
    v_emp, p_category, p_unit, p_start, p_end,
    CASE WHEN p_unit = 'hourly' THEN p_start_time END,
    CASE WHEN p_unit = 'hourly' THEN p_end_time   END,
    NULLIF(trim(p_reason), ''), v_status, v_days
  ) RETURNING id INTO v_id;

  IF v_status = 'pending_manager' THEN
    INSERT INTO public.notifications (user_id, type, message)
    SELECT unnest(manager_ids), 'leave', v_name || ' submitted a leave request for your approval.'
    FROM public.profiles WHERE id = v_emp;
  ELSE
    PERFORM public.notify_hr_approvers(v_name || ' submitted a leave request for HR approval.');
  END IF;

  RETURN v_id;
END;
$$;

-- HR sets / updates the allowance for one or many employees at once.
-- Now rejects when the category's office isn't visible to the caller, or
-- when any target employee lives outside that office.
CREATE OR REPLACE FUNCTION public.set_leave_balance(
  p_employees UUID[], p_category UUID, p_allowance NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_office UUID; v_bad INT;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT office_id INTO v_office FROM public.leave_categories WHERE id = p_category;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown leave category.'; END IF;
  IF NOT public.can_see_office(v_office) THEN
    RAISE EXCEPTION 'That leave category belongs to an office you cannot manage.';
  END IF;

  SELECT COUNT(*) INTO v_bad
    FROM unnest(p_employees) AS e(id)
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.id AND p.office_id = v_office);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Cannot set this category for % employee(s) outside its office.', v_bad;
  END IF;

  INSERT INTO public.leave_balances (employee_id, category_id, allowance)
  SELECT unnest(p_employees), p_category, p_allowance
  ON CONFLICT (employee_id, category_id)
  DO UPDATE SET allowance = EXCLUDED.allowance, updated_at = NOW();
END;
$$;

-- HR adds to / subtracts from the existing allowance. Same office guard as
-- set_leave_balance.
CREATE OR REPLACE FUNCTION public.adjust_leave_balance(
  p_employees UUID[], p_category UUID, p_delta NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_office UUID; v_bad INT;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT office_id INTO v_office FROM public.leave_categories WHERE id = p_category;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown leave category.'; END IF;
  IF NOT public.can_see_office(v_office) THEN
    RAISE EXCEPTION 'That leave category belongs to an office you cannot manage.';
  END IF;

  SELECT COUNT(*) INTO v_bad
    FROM unnest(p_employees) AS e(id)
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.id AND p.office_id = v_office);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Cannot adjust this category for % employee(s) outside its office.', v_bad;
  END IF;

  INSERT INTO public.leave_balances (employee_id, category_id, allowance)
  SELECT unnest(p_employees), p_category, GREATEST(0, p_delta)
  ON CONFLICT (employee_id, category_id)
  DO UPDATE SET allowance = GREATEST(0, public.leave_balances.allowance + p_delta), updated_at = NOW();
END;
$$;

-- HR: create/update a category's leave policy. The policy's office is
-- derived from the category, so only a visibility check is needed here.
CREATE OR REPLACE FUNCTION public.upsert_leave_policy(
  p_category UUID, p_default_days NUMERIC, p_rollover_enabled BOOLEAN,
  p_rollover_cap NUMERIC, p_rollover_expiry_months INT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID; v_office UUID;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT office_id INTO v_office FROM public.leave_categories WHERE id = p_category;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown leave category.'; END IF;
  IF NOT public.can_see_office(v_office) THEN
    RAISE EXCEPTION 'That leave category belongs to an office you cannot manage.';
  END IF;

  IF p_default_days IS NULL OR p_default_days < 0 THEN
    RAISE EXCEPTION 'Default days per year must be zero or positive.';
  END IF;
  IF p_rollover_cap IS NOT NULL AND p_rollover_cap < 0 THEN
    RAISE EXCEPTION 'Rollover cap cannot be negative.';
  END IF;
  IF p_rollover_expiry_months IS NOT NULL AND p_rollover_expiry_months <= 0 THEN
    RAISE EXCEPTION 'Rollover expiry must be a positive number of months.';
  END IF;

  INSERT INTO public.leave_policies
    (category_id, default_days_per_year, rollover_enabled, rollover_cap, rollover_expiry_months, updated_by)
  VALUES
    (p_category, p_default_days, COALESCE(p_rollover_enabled, false), p_rollover_cap, p_rollover_expiry_months, auth.uid())
  ON CONFLICT (category_id) DO UPDATE SET
    default_days_per_year  = EXCLUDED.default_days_per_year,
    rollover_enabled       = EXCLUDED.rollover_enabled,
    rollover_cap           = EXCLUDED.rollover_cap,
    rollover_expiry_months = EXCLUDED.rollover_expiry_months,
    updated_by             = auth.uid(),
    updated_at             = NOW()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Grant/refresh each employee's balance for their current anniversary cycle.
-- Idempotent (guarded by the leave_cycle_grants UNIQUE constraint).
--   p_employee = NULL   → process every office the caller can see (IT only —
--     the "Run leave cycle now" sweep lives in the IT Panel).
--   p_employee = <uuid> → process just that employee; a non-privileged
--     caller may only pass their OWN id (self-service "catch me up" call,
--     fired on every login).
CREATE OR REPLACE FUNCTION public.run_leave_cycle(p_employee UUID DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp            RECORD;
  v_pol            RECORD;
  v_cycle_start    DATE;
  v_cycle_end      DATE;
  v_prev_grant     RECORD;
  v_prev_used      NUMERIC;
  v_current_alw    NUMERIC;
  v_prev_remaining NUMERIC;
  v_carried_in     NUMERIC;
  v_carry_expires  DATE;
  v_count          INT := 0;
BEGIN
  IF p_employee IS NULL THEN
    IF NOT public.my_has_role('it') THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  ELSIF p_employee <> auth.uid() THEN
    IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
      RAISE EXCEPTION 'Not authorized.';
    END IF;
  END IF;

  FOR v_emp IN
    -- office_id correlates the policy loop below. The visibility predicate
    -- is defense in depth for the specific-employee case (id = auth.uid()
    -- always allowed — that's the login path); IT already sees every
    -- office, so it changes nothing for the NULL sweep.
    SELECT id, joining_date, office_id FROM public.profiles
     WHERE joining_date IS NOT NULL
       AND (p_employee IS NULL OR id = p_employee)
       AND (id = auth.uid() OR office_id = ANY(public.my_visible_office_ids()))
  LOOP
    v_cycle_start := public.leave_cycle_start(v_emp.joining_date, CURRENT_DATE);
    v_cycle_end   := (v_cycle_start + INTERVAL '1 year' - INTERVAL '1 day')::date;

    FOR v_pol IN
      -- A policy's office is resolved through its category — this one
      -- added predicate is the entire per-office cycle engine.
      SELECT lp.* FROM public.leave_policies lp
      JOIN public.leave_categories lc ON lc.id = lp.category_id
      WHERE lc.is_active AND lc.is_paid
        AND lc.office_id = v_emp.office_id
    LOOP
      IF EXISTS (
        SELECT 1 FROM public.leave_cycle_grants
        WHERE employee_id = v_emp.id AND category_id = v_pol.category_id AND cycle_start = v_cycle_start
      ) THEN
        CONTINUE;
      END IF;

      v_carried_in := 0;
      IF v_pol.rollover_enabled THEN
        SELECT * INTO v_prev_grant FROM public.leave_cycle_grants
          WHERE employee_id = v_emp.id AND category_id = v_pol.category_id
          ORDER BY cycle_start DESC LIMIT 1;

        IF FOUND THEN
          SELECT allowance INTO v_current_alw FROM public.leave_balances
            WHERE employee_id = v_emp.id AND category_id = v_pol.category_id;

          SELECT COALESCE(SUM(days_count), 0) INTO v_prev_used
            FROM public.leave_requests
            WHERE employee_id = v_emp.id AND category_id = v_pol.category_id
              AND status = 'approved'
              AND start_date >= v_prev_grant.cycle_start AND start_date <= v_prev_grant.cycle_end;

          v_prev_remaining := GREATEST(0, COALESCE(v_current_alw, 0) - v_prev_used);
          v_carried_in := LEAST(v_prev_remaining, COALESCE(v_pol.rollover_cap, v_prev_remaining));
        END IF;
      END IF;

      v_carry_expires := NULL;
      IF v_pol.rollover_enabled AND v_pol.rollover_expiry_months IS NOT NULL THEN
        v_carry_expires := (v_cycle_start + (v_pol.rollover_expiry_months || ' months')::interval)::date;
      END IF;

      INSERT INTO public.leave_balances (employee_id, category_id, allowance)
      VALUES (v_emp.id, v_pol.category_id, v_pol.default_days_per_year + v_carried_in)
      ON CONFLICT (employee_id, category_id)
      DO UPDATE SET allowance = v_pol.default_days_per_year + v_carried_in, updated_at = NOW();

      INSERT INTO public.leave_cycle_grants
        (employee_id, category_id, cycle_start, cycle_end, granted, carried_in, carry_expires_on)
      VALUES
        (v_emp.id, v_pol.category_id, v_cycle_start, v_cycle_end, v_pol.default_days_per_year, v_carried_in, v_carry_expires);

      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Claw back unused carried-in balance past expiry. Was company-wide
-- regardless of caller's office — closed here alongside the rest of the
-- per-office pass, even though it needs no *category* change.
CREATE OR REPLACE FUNCTION public.expire_carried_leave()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_grant        RECORD;
  v_used_since   NUMERIC;
  v_unused_carry NUMERIC;
  v_count        INT := 0;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  FOR v_grant IN
    SELECT g.* FROM public.leave_cycle_grants g
    JOIN public.profiles p ON p.id = g.employee_id
    WHERE g.carry_expires_on IS NOT NULL
      AND g.carry_expires_on < CURRENT_DATE
      AND g.carry_expired_at IS NULL
      AND g.carried_in > 0
      AND p.office_id = ANY(public.my_visible_office_ids())
  LOOP
    SELECT COALESCE(SUM(days_count), 0) INTO v_used_since
      FROM public.leave_requests
      WHERE employee_id = v_grant.employee_id AND category_id = v_grant.category_id
        AND status = 'approved'
        AND start_date >= v_grant.cycle_start AND start_date <= v_grant.carry_expires_on;

    v_unused_carry := GREATEST(0, v_grant.carried_in - GREATEST(0, v_used_since - v_grant.granted));

    IF v_unused_carry > 0 THEN
      UPDATE public.leave_balances
        SET allowance = GREATEST(0, allowance - v_unused_carry), updated_at = NOW()
        WHERE employee_id = v_grant.employee_id AND category_id = v_grant.category_id;
    END IF;

    UPDATE public.leave_cycle_grants SET carry_expired_at = NOW() WHERE id = v_grant.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- set_employee_offices: on a genuine office move, remap balances + cycle
-- grants by category NAME, preserving REMAINING days (allowance minus what
-- was already used this cycle) — unlike the migration backfill above,
-- this is a real transfer, so leave_requests history is deliberately left
-- on the old office's category.
CREATE OR REPLACE FUNCTION public.set_employee_offices(
  p_employees UUID[], p_home UUID, p_additional UUID[], p_sees_all BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_movers UUID[];
BEGIN
  IF NOT public.my_has_role('it') THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_home IS NULL THEN RAISE EXCEPTION 'A home office is required.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.offices WHERE id = p_home) THEN
    RAISE EXCEPTION 'Office not found.';
  END IF;

  -- Captured BEFORE the UPDATE — once office_id changes, the "old office"
  -- needed to match categories below is gone. Employees only having their
  -- additional offices edited are excluded, so their balances are untouched.
  SELECT COALESCE(array_agg(id), '{}') INTO v_movers
    FROM public.profiles
   WHERE id = ANY(p_employees) AND office_id IS DISTINCT FROM p_home;

  UPDATE public.profiles
    SET office_id             = p_home,
        additional_office_ids = COALESCE(p_additional, additional_office_ids),
        sees_all_offices      = COALESCE(p_sees_all, sees_all_offices),
        updated_at            = NOW()
    WHERE id = ANY(p_employees);

  IF cardinality(v_movers) = 0 THEN RETURN; END IF;

  -- Preserve REMAINING: reduce the balance by what was already used this
  -- cycle on the old category before carrying it to the new one. A
  -- category with no same-named counterpart in the destination office is
  -- left untouched (leave_cat_read_referenced keeps it readable so it
  -- doesn't render blank).
  UPDATE public.leave_balances src
     SET allowance = GREATEST(0, src.allowance - COALESCE((
           SELECT SUM(lr.days_count) FROM public.leave_requests lr
            WHERE lr.employee_id = src.employee_id
              AND lr.category_id = src.category_id
              AND lr.status = 'approved'
              AND lr.start_date >= public.leave_cycle_start(p.joining_date, CURRENT_DATE)
         ), 0)), updated_at = NOW()
    FROM public.profiles p, public.leave_categories sc
   WHERE p.id = src.employee_id AND p.joining_date IS NOT NULL
     AND src.employee_id = ANY(v_movers)
     AND sc.id = src.category_id AND sc.office_id <> p_home;

  -- Collision (destination category already has a balance row for this
  -- employee): keep the greater allowance, drop the stale row.
  UPDATE public.leave_balances dst
     SET allowance = GREATEST(dst.allowance, src.allowance), updated_at = NOW()
    FROM public.leave_balances src
    JOIN public.leave_categories sc ON sc.id = src.category_id
    JOIN public.leave_categories dc ON dc.office_id = p_home AND lower(dc.name) = lower(sc.name)
   WHERE src.employee_id = ANY(v_movers)
     AND sc.office_id <> p_home
     AND dst.employee_id = src.employee_id
     AND dst.category_id = dc.id;

  DELETE FROM public.leave_balances src
   USING public.leave_categories sc, public.leave_categories dc
   WHERE src.employee_id = ANY(v_movers)
     AND sc.id = src.category_id AND sc.office_id <> p_home
     AND dc.office_id = p_home AND lower(dc.name) = lower(sc.name)
     AND EXISTS (SELECT 1 FROM public.leave_balances d
                  WHERE d.employee_id = src.employee_id AND d.category_id = dc.id);

  UPDATE public.leave_balances src
     SET category_id = dc.id, updated_at = NOW()
    FROM public.leave_categories sc, public.leave_categories dc
   WHERE src.employee_id = ANY(v_movers)
     AND sc.id = src.category_id AND sc.office_id <> p_home
     AND dc.office_id = p_home AND lower(dc.name) = lower(sc.name);

  -- The grant row MUST follow the balance — it's run_leave_cycle()'s
  -- idempotency guard, and AuthContext fires that on every login. Leave it
  -- behind and the mover's next sign-in re-grants the current cycle
  -- against the destination category, overwriting the allowance just
  -- carefully preserved above with a bare default_days_per_year.
  DELETE FROM public.leave_cycle_grants src
   USING public.leave_categories sc, public.leave_categories dc
   WHERE src.employee_id = ANY(v_movers)
     AND sc.id = src.category_id AND sc.office_id <> p_home
     AND dc.office_id = p_home AND lower(dc.name) = lower(sc.name)
     AND EXISTS (SELECT 1 FROM public.leave_cycle_grants d
                  WHERE d.employee_id = src.employee_id AND d.category_id = dc.id
                    AND d.cycle_start = src.cycle_start);

  UPDATE public.leave_cycle_grants src
     SET category_id = dc.id
    FROM public.leave_categories sc, public.leave_categories dc
   WHERE src.employee_id = ANY(v_movers)
     AND sc.id = src.category_id AND sc.office_id <> p_home
     AND dc.office_id = p_home AND lower(dc.name) = lower(sc.name);

  -- leave_requests are deliberately NOT remapped — leave taken in the old
  -- office stays that office's history.
END;
$$;

COMMIT;
