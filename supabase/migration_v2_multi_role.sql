-- =============================================================
-- Migration v2: Multi-role system
-- Run this in the Supabase SQL editor on an existing database.
--
-- IMPORTANT: Must be run in TWO separate executions.
-- Copy Part 1, click Run, wait for success, then copy Part 2 and Run.
-- =============================================================

-- =============================================================
-- PART 1 OF 2 — Run this block first, then run Part 2 separately.
-- =============================================================

-- 1. Add new enum values
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'global_analytics';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'team_analytics';

-- 2. Add roles array column (if it doesn't exist)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS roles user_role[] NOT NULL DEFAULT '{}';

-- After running Part 1, scroll down and run Part 2.

-- =============================================================
-- PART 2 OF 2 — Run ONLY after Part 1 has succeeded.
-- =============================================================

-- 3. Migrate existing single-role data into the array column
--    Only updates rows where roles is still empty (idempotent).
UPDATE public.profiles
SET roles = ARRAY[role]
WHERE cardinality(roles) = 0;

-- 4. Helper: check if the current user has a given role
CREATE OR REPLACE FUNCTION public.my_has_role(r user_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
    AND (
      (cardinality(roles) > 0 AND r = ANY(roles))
      OR (cardinality(roles) = 0 AND role = r)
    )
  );
$$;

-- 5. Update RLS policies on profiles

DROP POLICY IF EXISTS "profiles_read_for_manager_select" ON public.profiles;
CREATE POLICY "profiles_read_for_manager_select" ON public.profiles
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND ('manager' = ANY(roles) OR 'c_suite' = ANY(roles))
  );

DROP POLICY IF EXISTS "profiles_read_privileged" ON public.profiles;
CREATE POLICY "profiles_read_privileged" ON public.profiles
  FOR SELECT USING (
    public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it')
  );

DROP POLICY IF EXISTS "profiles_update_it" ON public.profiles;
CREATE POLICY "profiles_update_it" ON public.profiles
  FOR UPDATE USING (public.my_has_role('it'));

-- 6. Update timesheets RLS policies

DROP POLICY IF EXISTS "timesheets_read_manager"          ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_read_privileged"       ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_update_manager"        ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_update_it"             ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_read_global_analytics" ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_read_team_analytics"   ON public.timesheets;

CREATE POLICY "timesheets_read_manager" ON public.timesheets
  FOR SELECT USING (
    (public.my_has_role('manager') OR public.my_has_role('c_suite'))
    AND public.i_manage(employee_id)
  );

CREATE POLICY "timesheets_read_privileged" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it')
  );

CREATE POLICY "timesheets_read_global_analytics" ON public.timesheets
  FOR SELECT USING (public.my_has_role('global_analytics'));

CREATE POLICY "timesheets_read_team_analytics" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('team_analytics') AND public.i_manage(employee_id)
  );

CREATE POLICY "timesheets_update_manager" ON public.timesheets
  FOR UPDATE USING (
    (public.my_has_role('manager') OR public.my_has_role('c_suite'))
    AND public.i_manage(employee_id)
  );

CREATE POLICY "timesheets_update_it" ON public.timesheets
  FOR UPDATE USING (public.my_has_role('it'));

-- 7. Update timesheet_entries RLS policies

DROP POLICY IF EXISTS "entries_read_manager"          ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_read_privileged"       ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_read_global_analytics" ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_read_team_analytics"   ON public.timesheet_entries;

CREATE POLICY "entries_read_manager" ON public.timesheet_entries
  FOR SELECT USING (
    (public.my_has_role('manager') OR public.my_has_role('c_suite'))
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      WHERE public.i_manage(t.employee_id)
    )
  );

CREATE POLICY "entries_read_privileged" ON public.timesheet_entries
  FOR SELECT USING (
    public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it')
  );

CREATE POLICY "entries_read_global_analytics" ON public.timesheet_entries
  FOR SELECT USING (public.my_has_role('global_analytics'));

CREATE POLICY "entries_read_team_analytics" ON public.timesheet_entries
  FOR SELECT USING (
    public.my_has_role('team_analytics')
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      WHERE public.i_manage(t.employee_id)
    )
  );

-- Done. Verify with:
-- SELECT id, email, role, roles FROM public.profiles LIMIT 10;
