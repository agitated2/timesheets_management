-- =============================================================
-- Migration v9: Joining dates & dynamic leave cycles
--
-- Employees get a joining_date; each paid leave category can define a
-- policy (default days/year, optional rollover with cap + expiry).
-- run_leave_cycle() grants/refreshes each employee's balance once per
-- anniversary year, idempotently (safe to re-run / call repeatedly).
--
-- IMPORTANT — this changes leave_balance_summary's "used" calculation.
-- Previously "used" summed ALL approved leave ever taken against a single,
-- manually-set allowance. Once cycles exist, that would make "remaining"
-- go deeply negative the moment a balance resets for a new cycle (old
-- usage would still count against the fresh allowance). "used" is now
-- scoped to the employee's CURRENT cycle window — but only for employees
-- who have a joining_date set. Employees without one keep the exact old
-- lifetime-cumulative behaviour, so nothing changes until you adopt this
-- feature for a given employee.
--
-- Idempotent — safe to re-run.
-- =============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS joining_date DATE;

-- One policy row per (paid) leave category.
CREATE TABLE IF NOT EXISTS public.leave_policies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id            UUID NOT NULL UNIQUE
                           REFERENCES public.leave_categories(id) ON DELETE CASCADE,
  default_days_per_year  NUMERIC(6,2) NOT NULL DEFAULT 0,
  rollover_enabled       BOOLEAN NOT NULL DEFAULT false,
  rollover_cap           NUMERIC(6,2),  -- NULL = uncapped
  rollover_expiry_months INT,           -- NULL = carried days never expire
  prorate_first_year     BOOLEAN NOT NULL DEFAULT true,  -- reserved; see note below
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             UUID REFERENCES public.profiles(id)
);
-- NOTE on prorate_first_year: under anniversary-based cycling (every cycle,
-- including an employee's first, runs exactly joining_date → +1 year) there
-- is no naturally partial first period to prorate — proration only means
-- something under calendar-year cycling. The column is kept for potential
-- future use but run_leave_cycle() does not currently branch on it, and the
-- HR UI does not expose it to avoid a checkbox that does nothing.

DROP TRIGGER IF EXISTS leave_policies_updated_at ON public.leave_policies;
CREATE TRIGGER leave_policies_updated_at BEFORE UPDATE ON public.leave_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Audit + idempotency record of every cycle granted.
CREATE TABLE IF NOT EXISTS public.leave_cycle_grants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id       UUID NOT NULL REFERENCES public.leave_categories(id) ON DELETE CASCADE,
  cycle_start       DATE NOT NULL,
  cycle_end         DATE NOT NULL,
  granted           NUMERIC(6,2) NOT NULL DEFAULT 0,
  carried_in        NUMERIC(6,2) NOT NULL DEFAULT 0,
  carry_expires_on  DATE,
  carry_expired_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, category_id, cycle_start)
);
CREATE INDEX IF NOT EXISTS idx_leave_cycle_grants_employee ON public.leave_cycle_grants(employee_id, category_id, cycle_start DESC);
CREATE INDEX IF NOT EXISTS idx_leave_cycle_grants_expiry   ON public.leave_cycle_grants(carry_expires_on) WHERE carry_expired_at IS NULL;

ALTER TABLE public.leave_policies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_cycle_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leave_policies_read" ON public.leave_policies;
CREATE POLICY "leave_policies_read" ON public.leave_policies
  FOR SELECT USING (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'));
-- No direct INSERT/UPDATE policy — writes only via upsert_leave_policy()
-- (SECURITY DEFINER), matching the project_audit_logs append-only pattern.

DROP POLICY IF EXISTS "leave_cycle_grants_read_own"        ON public.leave_cycle_grants;
DROP POLICY IF EXISTS "leave_cycle_grants_read_privileged" ON public.leave_cycle_grants;
CREATE POLICY "leave_cycle_grants_read_own" ON public.leave_cycle_grants
  FOR SELECT USING (auth.uid() = employee_id);
CREATE POLICY "leave_cycle_grants_read_privileged" ON public.leave_cycle_grants
  FOR SELECT USING (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'));

-- ---------------------------------------------------------------
-- Most recent anniversary of p_joining on or before p_today.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leave_cycle_start(p_joining DATE, p_today DATE)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (p_joining + ((date_part('year', age(p_today, p_joining)))::int || ' years')::interval)::date <= p_today
    THEN (p_joining + ((date_part('year', age(p_today, p_joining)))::int || ' years')::interval)::date
    ELSE (p_joining + ((date_part('year', age(p_today, p_joining)))::int - 1 || ' years')::interval)::date
  END;
$$;

-- ---------------------------------------------------------------
-- HR: create/update a category's leave policy.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_leave_policy(
  p_category UUID, p_default_days NUMERIC, p_rollover_enabled BOOLEAN,
  p_rollover_cap NUMERIC, p_rollover_expiry_months INT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
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

-- ---------------------------------------------------------------
-- HR / Employee Overview: set an employee's joining date.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_joining_date(p_employees UUID[], p_date DATE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.my_has_role('employee_overview') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  UPDATE public.profiles SET joining_date = p_date, updated_at = NOW() WHERE id = ANY(p_employees);
END;
$$;

-- ---------------------------------------------------------------
-- Grant/refresh each employee's balance for their current anniversary
-- cycle. Idempotent (guarded by the leave_cycle_grants UNIQUE constraint),
-- safe to call repeatedly — via pg_cron, an HR-triggered sweep, or a lazy
-- self-scoped call on login.
--
-- p_employee = NULL  → process everyone (HR/IT only).
-- p_employee = <uuid> → process just that employee; a non-privileged
--   caller may only pass their OWN id (self-service "catch me up" call).
-- ---------------------------------------------------------------
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
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    IF p_employee IS NULL OR p_employee <> auth.uid() THEN
      RAISE EXCEPTION 'Not authorized.';
    END IF;
  END IF;

  FOR v_emp IN
    SELECT id, joining_date FROM public.profiles
    WHERE joining_date IS NOT NULL
      AND (p_employee IS NULL OR id = p_employee)
  LOOP
    v_cycle_start := public.leave_cycle_start(v_emp.joining_date, CURRENT_DATE);
    v_cycle_end   := (v_cycle_start + INTERVAL '1 year' - INTERVAL '1 day')::date;

    FOR v_pol IN
      SELECT lp.* FROM public.leave_policies lp
      JOIN public.leave_categories lc ON lc.id = lp.category_id
      WHERE lc.is_active AND lc.is_paid
    LOOP
      -- Idempotency guard: already granted this cycle → skip.
      IF EXISTS (
        SELECT 1 FROM public.leave_cycle_grants
        WHERE employee_id = v_emp.id AND category_id = v_pol.category_id AND cycle_start = v_cycle_start
      ) THEN
        CONTINUE;
      END IF;

      -- Carry-in from the previous cycle (if any), based on the LIVE
      -- balance (so manual HR adjustments made mid-cycle are respected,
      -- not silently wiped out by the rollover), minus what was actually
      -- used during that previous cycle window.
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

-- ---------------------------------------------------------------
-- Claw back the unused portion of any carried-in balance whose expiry
-- date has passed. HR/IT only — processes everyone, so no self-service
-- angle applies. Idempotent via carry_expired_at.
-- ---------------------------------------------------------------
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
    SELECT * FROM public.leave_cycle_grants
    WHERE carry_expires_on IS NOT NULL
      AND carry_expires_on < CURRENT_DATE
      AND carry_expired_at IS NULL
      AND carried_in > 0
  LOOP
    -- Approved usage from cycle_start up to the expiry date. The granted
    -- (non-carried) portion is treated as used first; only carry left over
    -- above that actually expires.
    SELECT COALESCE(SUM(days_count), 0) INTO v_used_since
      FROM public.leave_requests
      WHERE employee_id = v_grant.employee_id AND category_id = v_grant.category_id
        AND status = 'approved'
        AND start_date >= v_grant.cycle_start AND start_date <= v_grant.carry_expires_on;

    v_unused_carry := GREATEST(0, v_grant.carried_in - GREATEST(0, v_used_since - v_grant.granted));

    IF v_unused_carry > 0 THEN
      -- Direct mutation (not the public adjust_leave_balance RPC): this
      -- runs as a system maintenance sweep and must not re-check the
      -- caller's role a second time against the balance table.
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

-- ---------------------------------------------------------------
-- BALANCE SUMMARY VIEW — cycle-scoped "used" for employees who have a
-- joining_date; unchanged lifetime-cumulative behaviour for those who
-- don't (see the migration header note).
-- ---------------------------------------------------------------
DROP VIEW IF EXISTS public.leave_balance_summary;
CREATE VIEW public.leave_balance_summary WITH (security_invoker = true) AS
SELECT
  b.employee_id,
  b.category_id,
  c.name    AS category_name,
  c.is_paid,
  b.allowance,
  COALESCE((
    SELECT SUM(lr.days_count) FROM public.leave_requests lr
    WHERE lr.employee_id = b.employee_id
      AND lr.category_id = b.category_id
      AND lr.status = 'approved'
      AND (p.joining_date IS NULL OR lr.start_date >= public.leave_cycle_start(p.joining_date, CURRENT_DATE))
  ), 0) AS used,
  b.allowance - COALESCE((
    SELECT SUM(lr.days_count) FROM public.leave_requests lr
    WHERE lr.employee_id = b.employee_id
      AND lr.category_id = b.category_id
      AND lr.status = 'approved'
      AND (p.joining_date IS NULL OR lr.start_date >= public.leave_cycle_start(p.joining_date, CURRENT_DATE))
  ), 0) AS remaining
FROM public.leave_balances b
JOIN public.leave_categories c ON c.id = b.category_id
JOIN public.profiles p ON p.id = b.employee_id;
