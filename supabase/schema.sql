-- =============================================================
-- Timesheet Management — Supabase Schema
-- Run this entire file in the Supabase SQL editor (fresh install).
-- This is the single source of truth — no migration files needed for a new database.
-- After running, also:
--   1. Create a private storage bucket named: timesheet-files
--   2. Enable Realtime for the `notifications` table in the Supabase dashboard
--   3. Set the first IT/admin user's roles manually:
--      UPDATE public.profiles SET roles = '{it}' WHERE email = 'admin@yourcompany.com';
-- =============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Custom types
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('employee', 'manager', 'hr', 'c_suite', 'it', 'global_analytics', 'team_analytics', 'projects_control');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE timesheet_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM ('submission', 'approval', 'rejection');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ---------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  full_name       TEXT,
  role            user_role NOT NULL DEFAULT 'employee',   -- legacy; kept for fallback
  roles           user_role[] NOT NULL DEFAULT '{}',       -- primary multi-role array
  manager_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,  -- legacy single manager
  manager_ids     UUID[] NOT NULL DEFAULT '{}',                             -- primary multi-manager array
  onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.timesheets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  status          timesheet_status NOT NULL DEFAULT 'pending',
  reviewer_id     UUID REFERENCES public.profiles(id),
  rejection_reason TEXT,
  file_path       TEXT NOT NULL,
  total_hours     DECIMAL(5,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.timesheet_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id    UUID NOT NULL REFERENCES public.timesheets(id) ON DELETE CASCADE,
  time_from       TIME,
  time_to         TIME,
  hours_decimal   DECIMAL(4,2),
  project_name    TEXT,
  task            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type            notification_type NOT NULL,
  message         TEXT NOT NULL,
  timesheet_id    UUID REFERENCES public.timesheets(id) ON DELETE SET NULL,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_timesheets_employee  ON public.timesheets(employee_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_status    ON public.timesheets(status);
CREATE INDEX IF NOT EXISTS idx_timesheets_date      ON public.timesheets(date);
CREATE INDEX IF NOT EXISTS idx_entries_timesheet    ON public.timesheet_entries(timesheet_id);
CREATE INDEX IF NOT EXISTS idx_entries_project      ON public.timesheet_entries(project_name);
CREATE INDEX IF NOT EXISTS idx_notif_user           ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_unread         ON public.notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_profiles_manager     ON public.profiles(manager_id);
CREATE INDEX IF NOT EXISTS idx_profiles_manager_ids ON public.profiles USING gin(manager_ids);

-- ---------------------------------------------------------------
-- TRIGGERS & FUNCTIONS
-- ---------------------------------------------------------------

-- Auto-create profile row on new auth user
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS timesheets_updated_at ON public.timesheets;
CREATE TRIGGER timesheets_updated_at
  BEFORE UPDATE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Notify all assigned managers on new timesheet submission
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

DROP TRIGGER IF EXISTS on_timesheet_submission ON public.timesheets;
CREATE TRIGGER on_timesheet_submission
  AFTER INSERT ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_submission();

-- Notify employee on approval or rejection
CREATE OR REPLACE FUNCTION public.notify_on_review()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_reviewer_name TEXT;
  v_msg           TEXT;
  v_notif_type    notification_type;
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT COALESCE(full_name, email) INTO v_reviewer_name
  FROM public.profiles WHERE id = NEW.reviewer_id;

  IF NEW.status = 'approved' THEN
    v_msg        := 'Your timesheet for ' || TO_CHAR(NEW.date, 'Mon DD, YYYY') ||
                   ' was approved by ' || COALESCE(v_reviewer_name, 'a reviewer') || '.';
    v_notif_type := 'approval';
  ELSIF NEW.status = 'rejected' THEN
    v_msg        := 'Your timesheet for ' || TO_CHAR(NEW.date, 'Mon DD, YYYY') ||
                   ' was rejected by ' || COALESCE(v_reviewer_name, 'a reviewer') ||
                   '. Reason: ' || COALESCE(NEW.rejection_reason, 'No reason provided') || '.';
    v_notif_type := 'rejection';
  END IF;

  IF v_msg IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, message, timesheet_id)
    VALUES (NEW.employee_id, v_notif_type, v_msg, NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_timesheet_review ON public.timesheets;
CREATE TRIGGER on_timesheet_review
  AFTER UPDATE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_review();

-- ---------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------

ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications     ENABLE ROW LEVEL SECURITY;

-- Helper: check if current user has a given role (checks roles array, falls back to legacy column)
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

-- Helper: check if current user manages given employee (via manager_ids array)
CREATE OR REPLACE FUNCTION public.i_manage(emp_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = emp_id AND auth.uid() = ANY(manager_ids)
  );
$$;

-- ---- PROFILES ----

-- All authenticated users can see manager/c_suite profiles (for onboarding + settings dropdown)
DROP POLICY IF EXISTS "profiles_read_for_manager_select" ON public.profiles;
CREATE POLICY "profiles_read_for_manager_select" ON public.profiles
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND ('manager' = ANY(roles) OR 'c_suite' = ANY(roles))
  );

-- Users can read their own profile
DROP POLICY IF EXISTS "profiles_read_own" ON public.profiles;
CREATE POLICY "profiles_read_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- Managers/C-Suite can read their subordinates
DROP POLICY IF EXISTS "profiles_read_subordinates" ON public.profiles;
CREATE POLICY "profiles_read_subordinates" ON public.profiles
  FOR SELECT USING (auth.uid() = ANY(manager_ids));

-- HR/C-Suite/IT can read all profiles
DROP POLICY IF EXISTS "profiles_read_privileged" ON public.profiles;
CREATE POLICY "profiles_read_privileged" ON public.profiles
  FOR SELECT USING (
    public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it')
  );

-- Users can update their own profile
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Global analytics can read all profiles (needed to populate employee list)
DROP POLICY IF EXISTS "profiles_read_global_analytics" ON public.profiles;
CREATE POLICY "profiles_read_global_analytics" ON public.profiles
  FOR SELECT USING (public.my_has_role('global_analytics'));

-- IT can update any profile (role management)
DROP POLICY IF EXISTS "profiles_update_it" ON public.profiles;
CREATE POLICY "profiles_update_it" ON public.profiles
  FOR UPDATE USING (public.my_has_role('it'));

-- ---- TIMESHEETS ----

DROP POLICY IF EXISTS "timesheets_read_own"              ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_read_manager"          ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_read_privileged"       ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_read_global_analytics" ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_read_team_analytics"   ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_insert_own"            ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_update_manager"        ON public.timesheets;
DROP POLICY IF EXISTS "timesheets_update_it"             ON public.timesheets;

CREATE POLICY "timesheets_read_own" ON public.timesheets
  FOR SELECT USING (auth.uid() = employee_id);

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

CREATE POLICY "timesheets_insert_own" ON public.timesheets
  FOR INSERT WITH CHECK (auth.uid() = employee_id);

CREATE POLICY "timesheets_update_manager" ON public.timesheets
  FOR UPDATE USING (
    (public.my_has_role('manager') OR public.my_has_role('c_suite'))
    AND public.i_manage(employee_id)
  );

CREATE POLICY "timesheets_update_it" ON public.timesheets
  FOR UPDATE USING (public.my_has_role('it'));

-- ---- TIMESHEET_ENTRIES ----

DROP POLICY IF EXISTS "entries_read_own"              ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_read_manager"          ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_read_privileged"       ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_read_global_analytics" ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_read_team_analytics"   ON public.timesheet_entries;
DROP POLICY IF EXISTS "entries_insert_own"            ON public.timesheet_entries;

CREATE POLICY "entries_read_own" ON public.timesheet_entries
  FOR SELECT USING (
    timesheet_id IN (SELECT id FROM public.timesheets WHERE employee_id = auth.uid())
  );

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

CREATE POLICY "entries_insert_own" ON public.timesheet_entries
  FOR INSERT WITH CHECK (
    timesheet_id IN (SELECT id FROM public.timesheets WHERE employee_id = auth.uid())
  );

-- ---- NOTIFICATIONS ----

DROP POLICY IF EXISTS "notif_read_own"   ON public.notifications;
DROP POLICY IF EXISTS "notif_update_own" ON public.notifications;

CREATE POLICY "notif_read_own" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "notif_update_own" ON public.notifications
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- PROJECTS
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  status      project_status NOT NULL DEFAULT 'active',
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_lower ON public.projects(lower(name));

CREATE TABLE IF NOT EXISTS public.project_stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  start_date  DATE,
  end_date    DATE,
  order_index INT NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.project_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, employee_id)
);

CREATE TABLE IF NOT EXISTS public.project_stage_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id    UUID NOT NULL REFERENCES public.project_stages(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  changed_by  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  change_type TEXT NOT NULL,
  old_start   DATE,
  new_start   DATE,
  old_end     DATE,
  new_end     DATE,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_stages_project   ON public.project_stages(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project  ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_employee ON public.project_members(employee_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_project       ON public.project_stage_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_stage         ON public.project_stage_logs(stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_created       ON public.project_stage_logs(created_at DESC);

DROP TRIGGER IF EXISTS projects_updated_at ON public.projects;
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS project_stages_updated_at ON public.project_stages;
CREATE TRIGGER project_stages_updated_at BEFORE UPDATE ON public.project_stages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_stages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_stage_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_manage"      ON public.projects;
DROP POLICY IF EXISTS "projects_read_member" ON public.projects;
CREATE POLICY "projects_manage" ON public.projects
  FOR ALL USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "projects_read_member" ON public.projects
  FOR SELECT USING (
    id IN (SELECT project_id FROM public.project_members WHERE employee_id = auth.uid())
  );

DROP POLICY IF EXISTS "stages_manage"      ON public.project_stages;
DROP POLICY IF EXISTS "stages_read_member" ON public.project_stages;
CREATE POLICY "stages_manage" ON public.project_stages
  FOR ALL USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "stages_read_member" ON public.project_stages
  FOR SELECT USING (
    project_id IN (SELECT project_id FROM public.project_members WHERE employee_id = auth.uid())
  );

DROP POLICY IF EXISTS "members_manage"   ON public.project_members;
DROP POLICY IF EXISTS "members_read_own" ON public.project_members;
CREATE POLICY "members_manage" ON public.project_members
  FOR ALL USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "members_read_own" ON public.project_members
  FOR SELECT USING (employee_id = auth.uid());

DROP POLICY IF EXISTS "stage_logs_read"   ON public.project_stage_logs;
DROP POLICY IF EXISTS "stage_logs_insert" ON public.project_stage_logs;
CREATE POLICY "stage_logs_read" ON public.project_stage_logs
  FOR SELECT USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "stage_logs_insert" ON public.project_stage_logs
  FOR INSERT WITH CHECK (public.my_has_role('projects_control') OR public.my_has_role('it'));

-- ---------------------------------------------------------------
-- STORAGE POLICIES (run after creating the bucket manually)
-- Bucket name: timesheet-files   Type: Private
-- ---------------------------------------------------------------
-- INSERT: employees upload to their own folder  {userId}/{filename}
-- SELECT: owner + their manager/c_suite + hr/it

-- Uncomment and run after creating the bucket:
/*
CREATE POLICY "storage_upload_own"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'timesheet-files'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "storage_read_own"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'timesheet-files'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "storage_read_manager"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'timesheet-files'
  AND public.my_role() IN ('manager', 'c_suite')
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.profiles WHERE manager_id = auth.uid()
  )
);

CREATE POLICY "storage_read_privileged"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'timesheet-files'
  AND public.my_role() IN ('hr', 'c_suite', 'it')
);
*/
