-- =============================================================
-- Migration v4: Multi-Manager Support
-- Run this entire file in a single execution in the Supabase SQL Editor.
-- =============================================================

-- 1. Add manager_ids array column
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS manager_ids UUID[] NOT NULL DEFAULT '{}';

-- 2. Backfill: copy existing single manager_id into the new array
UPDATE public.profiles
  SET manager_ids = ARRAY[manager_id]
  WHERE manager_id IS NOT NULL AND cardinality(manager_ids) = 0;

-- 3. GIN index for fast array containment queries
DROP INDEX IF EXISTS idx_profiles_manager;
CREATE INDEX IF NOT EXISTS idx_profiles_manager_ids ON public.profiles USING gin(manager_ids);

-- 4. Update i_manage() to use manager_ids array
CREATE OR REPLACE FUNCTION public.i_manage(emp_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = emp_id AND auth.uid() = ANY(manager_ids)
  );
$$;

-- 5. Update submission notification to notify ALL assigned managers
CREATE OR REPLACE FUNCTION public.notify_on_submission()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_manager_id  UUID;
  v_manager_ids UUID[];
  v_emp_name    TEXT;
BEGIN
  SELECT manager_ids, COALESCE(full_name, email)
  INTO v_manager_ids, v_emp_name
  FROM public.profiles
  WHERE id = NEW.employee_id;

  IF v_manager_ids IS NOT NULL AND cardinality(v_manager_ids) > 0 THEN
    FOREACH v_manager_id IN ARRAY v_manager_ids LOOP
      INSERT INTO public.notifications (user_id, type, message, timesheet_id)
      VALUES (
        v_manager_id,
        'submission',
        v_emp_name || ' submitted a timesheet for ' || TO_CHAR(NEW.date, 'Mon DD, YYYY'),
        NEW.id
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

-- 6. Update subordinates RLS policy to use manager_ids
DROP POLICY IF EXISTS "profiles_read_subordinates" ON public.profiles;
CREATE POLICY "profiles_read_subordinates" ON public.profiles
  FOR SELECT USING (auth.uid() = ANY(manager_ids));

-- Note: manager_id (singular) column is retained for backward compatibility.
-- All new assignments should write to manager_ids.
-- SELECT: SELECT * FROM public.profiles WHERE cardinality(manager_ids) > 0 LIMIT 5;
