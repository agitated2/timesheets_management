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
-- NOTE: the granular hr_* values are the HR-Panel permission flags. On a FRESH
-- install they are created inline below. If UPGRADING an existing database, run
-- these once FIRST, on their own (ADD VALUE cannot be used in the same
-- transaction that creates it):
--   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'hr_view_timesheets';
--   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'hr_manage_policies';
--   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'hr_manage_calendar';
--   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'hr_approve_requests';
--   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'employee_overview';
--   ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'leave';
--   ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'project';
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'employee', 'manager', 'hr', 'c_suite', 'it',
    'global_analytics', 'team_analytics', 'projects_control',
    'hr_view_timesheets', 'hr_manage_policies', 'hr_manage_calendar', 'hr_approve_requests',
    'employee_overview'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE timesheet_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM ('submission', 'approval', 'rejection', 'leave', 'project');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE project_tracking_type AS ENUM ('date', 'hours');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE stage_state AS ENUM ('active', 'soft_closed', 'hard_locked');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE leave_unit AS ENUM ('daily', 'hourly');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE leave_request_status AS ENUM (
    'pending_manager', 'pending_hr', 'approved', 'rejected', 'cancelled', 'revoked'
  );
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

-- Auto-create profile row on new auth user. office_id is NOT NULL (see
-- the OFFICES section below) so it must be supplied at creation time via
-- auth user_metadata — create-user.js always passes it. There is no safe
-- window to backfill office_id after this INSERT: profiles.office_id
-- being NULL, even briefly, makes that row visible to every office (see
-- the `o IS NULL` safety valve in can_see_office).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, office_id)
  VALUES (NEW.id, NEW.email, NULLIF(NEW.raw_user_meta_data->>'office_id', '')::UUID)
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

-- ===============================================================
-- OFFICES (RLS-based multi-tenancy, see migration_v10)
-- Every profile/project belongs to a home office; visibility of
-- office-scoped tables is gated by can_see_office() below. IT and
-- sees_all_offices bypass the restriction entirely. Defined here (before
-- the PROFILES policies below) because several of them reference
-- can_see_office(). projects.office_id + the office admin RPCs are added
-- further down, once the projects table exists.
-- ===============================================================
CREATE TABLE IF NOT EXISTS public.offices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  -- IANA name; every "today"/"late" decision the reminder job makes is
  -- computed against this, not the server's or a browser's clock.
  timezone           TEXT NOT NULL DEFAULT 'Asia/Dubai',
  timesheet_deadline TIME NOT NULL DEFAULT '18:00',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offices_name_lower ON public.offices(lower(name));

-- Validate against pg_timezone_names rather than a CHECK constraint —
-- that view isn't IMMUTABLE, so Postgres won't allow it in a CHECK.
CREATE OR REPLACE FUNCTION public.guard_office_timezone()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
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

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS office_id             UUID REFERENCES public.offices(id),
  ADD COLUMN IF NOT EXISTS additional_office_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sees_all_offices      BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_profiles_office ON public.profiles(office_id);
-- A fresh install has no pre-existing rows to backfill/lock down like the
-- migration does, but office_id must still end up NOT NULL so no future
-- row is ever visible to every office.
ALTER TABLE public.profiles ALTER COLUMN office_id SET NOT NULL;

ALTER TABLE public.offices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "offices_read" ON public.offices;
CREATE POLICY "offices_read" ON public.offices
  FOR SELECT USING (auth.uid() IS NOT NULL);
-- No direct INSERT/UPDATE policy — writes only via upsert_office() (SECURITY DEFINER).

-- All offices a given user may READ. IT and sees_all_offices get
-- everything. Generalized to an arbitrary user (not just auth.uid()) so
-- the reminder job can ask "what can THIS recipient see" the same way RLS
-- answers it for the caller's own session — my_has_role() is hardcoded to
-- auth.uid() and can't be reused here, so the roles-array-with-legacy-
-- role-column fallback is inlined to match it exactly.
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

-- STABLE matters: the planner evaluates the array once per statement, so
-- `= ANY(...)` in can_see_office costs about the same as plain equality.
CREATE OR REPLACE FUNCTION public.my_visible_office_ids()
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.visible_office_ids_for(auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.can_see_office(o UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o IS NULL OR o = ANY(public.my_visible_office_ids());
$$;

-- Caller's home office (see migration_v11) — used as the leave_categories
-- office_id default so a direct client INSERT without an explicit office
-- lands in the creator's own office rather than failing NOT NULL.
CREATE OR REPLACE FUNCTION public.my_office_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT office_id FROM public.profiles WHERE id = auth.uid();
$$;

-- ---- PROFILES ----

-- All authenticated users can see manager/c_suite profiles (for onboarding + settings dropdown)
DROP POLICY IF EXISTS "profiles_read_for_manager_select" ON public.profiles;
CREATE POLICY "profiles_read_for_manager_select" ON public.profiles
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND ('manager' = ANY(roles) OR 'c_suite' = ANY(roles))
    AND public.can_see_office(office_id)
  );

-- Users can read their own profile
DROP POLICY IF EXISTS "profiles_read_own" ON public.profiles;
CREATE POLICY "profiles_read_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- Managers/C-Suite can read their subordinates
DROP POLICY IF EXISTS "profiles_read_subordinates" ON public.profiles;
CREATE POLICY "profiles_read_subordinates" ON public.profiles
  FOR SELECT USING (auth.uid() = ANY(manager_ids) AND public.can_see_office(office_id));

-- HR/C-Suite/IT can read all profiles
DROP POLICY IF EXISTS "profiles_read_privileged" ON public.profiles;
CREATE POLICY "profiles_read_privileged" ON public.profiles
  FOR SELECT USING (
    (public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it'))
    AND public.can_see_office(office_id)
  );

-- Users can update their own profile
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Global analytics can read all profiles (needed to populate employee list)
DROP POLICY IF EXISTS "profiles_read_global_analytics" ON public.profiles;
CREATE POLICY "profiles_read_global_analytics" ON public.profiles
  FOR SELECT USING (public.my_has_role('global_analytics') AND public.can_see_office(office_id));

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
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

CREATE POLICY "timesheets_read_privileged" ON public.timesheets
  FOR SELECT USING (
    (public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

CREATE POLICY "timesheets_read_global_analytics" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('global_analytics')
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

CREATE POLICY "timesheets_read_team_analytics" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('team_analytics') AND public.i_manage(employee_id)
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
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
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.i_manage(t.employee_id) AND public.can_see_office(pr.office_id)
    )
  );

CREATE POLICY "entries_read_privileged" ON public.timesheet_entries
  FOR SELECT USING (
    (public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it'))
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

CREATE POLICY "entries_read_global_analytics" ON public.timesheet_entries
  FOR SELECT USING (
    public.my_has_role('global_analytics')
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

CREATE POLICY "entries_read_team_analytics" ON public.timesheet_entries
  FOR SELECT USING (
    public.my_has_role('team_analytics')
    AND timesheet_id IN (
      SELECT t.id FROM public.timesheets t
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.i_manage(t.employee_id) AND public.can_see_office(pr.office_id)
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
-- APP SETTINGS — singleton row of feature flags (see migration_v8).
-- Currently just the XLSX upload toggle; in-app entry is the default.
-- ---------------------------------------------------------------
-- reminder_backlog_days defaults to 2, not the steady-state value of ~14
-- you'll likely want: the FIRST time reminders are enabled against a
-- database with real history, a 14-day backlog mails every outstanding day
-- back to go-live to every employee, manager and HR recipient in one run.
-- Raise it once you've confirmed a couple of clean runs.
CREATE TABLE IF NOT EXISTS public.app_settings (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  xlsx_upload_enabled    BOOLEAN NOT NULL DEFAULT false,
  reminder_enabled       BOOLEAN NOT NULL DEFAULT true,
  reminder_hour          INT     NOT NULL DEFAULT 9,
  reminder_backlog_days  INT     NOT NULL DEFAULT 2,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             UUID REFERENCES public.profiles(id)
);
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "settings_read"   ON public.app_settings;
DROP POLICY IF EXISTS "settings_manage" ON public.app_settings;
CREATE POLICY "settings_read" ON public.app_settings
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "settings_manage" ON public.app_settings
  FOR ALL USING (public.my_has_role('it')) WITH CHECK (public.my_has_role('it'));

-- ---------------------------------------------------------------
-- REMINDER LOG — at-most-once-per-recipient-per-day guarantee for the
-- daily timesheet reminder job. RLS enabled with NO policies: invisible
-- to anon/authenticated, readable/writable only by the service-role job.
-- ---------------------------------------------------------------
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
-- recipient for the rest of the business day. A 'pending' or 'sent' row
-- still blocks a duplicate claim, which is the actual guarantee this
-- index exists for.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_log_recipient_date
  ON public.reminder_log (recipient_id, business_date) WHERE status <> 'failed';

ALTER TABLE public.reminder_log ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------
-- ONE TIMESHEET PER EMPLOYEE PER DAY (see migration_v8)
-- An employee may hold at most one pending-or-approved timesheet per date;
-- resubmission is possible once a manager rejects the previous one.
-- ---------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_timesheets_one_per_day
  ON public.timesheets (employee_id, date)
  WHERE status IN ('pending', 'approved');

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
  is_archived BOOLEAN NOT NULL DEFAULT false,
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

-- ===============================================================
-- OFFICES, continued — project scoping + admin RPCs. The offices table,
-- profiles.office_id, and can_see_office()/my_visible_office_ids() are
-- defined earlier (right after i_manage()) so the PROFILES policies
-- above can reference them; projects.office_id is added here since the
-- projects table doesn't exist until this point in the script.
-- ===============================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id);
CREATE INDEX IF NOT EXISTS idx_projects_office ON public.projects(office_id);
-- A fresh install has no pre-existing rows to backfill/lock down like the
-- migration does, but office_id must still end up NOT NULL so no future
-- row is ever visible to every office.
ALTER TABLE public.projects ALTER COLUMN office_id SET NOT NULL;

-- Create or rename an office (IT only). New offices get their own
-- weekend/holiday calendar automatically (Fri/Sat default) so
-- emp_calendar() always resolves once an employee's home office is set.
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

-- Bulk-assign home office / additional offices / sees_all_offices (IT
-- only). p_home is always applied; p_additional/p_sees_all are only
-- touched when non-NULL, so a bulk "move these employees to office X"
-- call can pass NULL for both without wiping out each employee's
-- existing additional offices or sees_all_offices flag.
-- On a genuine office move, remaps balances + cycle grants by category
-- NAME, preserving REMAINING days (allowance minus what was already used
-- this cycle) — see migration_v11. leave_requests history is deliberately
-- left on the old office's category.
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

-- ===============================================================
-- HR PANEL · LEAVES · REQUESTS · CALENDAR
-- ===============================================================

-- Link timesheet entries to canonical project / stage rows (additive; nullable).
-- These let the HR review page filter by project and stage reliably instead of
-- by free text. Populated by the upload paths going forward; legacy rows stay NULL.
ALTER TABLE public.timesheet_entries
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id)       ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_id   UUID REFERENCES public.project_stages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_entries_project_id ON public.timesheet_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_stage_id   ON public.timesheet_entries(stage_id);

-- ---------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------

-- Dynamic leave categories created by HR (Paid, Sick, Unpaid, Study, …).
-- Per-office (see migration_v11) — a fresh install has no pre-existing rows
-- to backfill, so office_id is declared NOT NULL directly, same reasoning
-- as profiles.office_id / projects.office_id in the OFFICES section above.
CREATE TABLE IF NOT EXISTS public.leave_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  office_id   UUID NOT NULL REFERENCES public.offices(id) DEFAULT public.my_office_id(),
  is_paid     BOOLEAN NOT NULL DEFAULT true,   -- false = record-only, no balance deduction
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_categories_office_name_lower ON public.leave_categories(office_id, lower(name));

-- Per-employee, per-category allowance (in days). HR sets this manually.
-- Usage is computed (allowance − Σ approved days_count), never mutated in place.
CREATE TABLE IF NOT EXISTS public.leave_balances (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.profiles(id)        ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.leave_categories(id) ON DELETE CASCADE,
  allowance   NUMERIC(7,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, category_id)
);

-- Leave / WFH / misc requests with two-tier approval pipeline.
CREATE TABLE IF NOT EXISTS public.leave_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       UUID NOT NULL REFERENCES public.profiles(id)        ON DELETE CASCADE,
  category_id       UUID NOT NULL REFERENCES public.leave_categories(id) ON DELETE RESTRICT,
  unit              leave_unit NOT NULL,
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,                 -- = start_date for hourly
  start_time        TIME,                          -- hourly only
  end_time          TIME,                          -- hourly only
  reason            TEXT,
  status            leave_request_status NOT NULL DEFAULT 'pending_manager',
  days_count        NUMERIC(7,2) NOT NULL DEFAULT 0,  -- working-day equivalent deducted from balance
  tier1_approver_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  tier1_at          TIMESTAMPTZ,
  hr_approver_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  hr_at             TIMESTAMPTZ,
  rejection_reason  TEXT,
  revoked_by        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON public.leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status   ON public.leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_dates    ON public.leave_requests(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_category ON public.leave_requests(category_id);

-- ---------------------------------------------------------------
-- JOINING DATE & DYNAMIC LEAVE CYCLES (see migration_v9)
-- Each paid leave category can define a policy (default days/year,
-- optional rollover with cap + expiry). run_leave_cycle() grants/refreshes
-- an employee's balance once per anniversary year, idempotently.
-- ---------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS joining_date DATE;

CREATE TABLE IF NOT EXISTS public.leave_policies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id            UUID NOT NULL UNIQUE
                           REFERENCES public.leave_categories(id) ON DELETE CASCADE,
  default_days_per_year  NUMERIC(6,2) NOT NULL DEFAULT 0,
  rollover_enabled       BOOLEAN NOT NULL DEFAULT false,
  rollover_cap           NUMERIC(6,2),  -- NULL = uncapped
  rollover_expiry_months INT,           -- NULL = carried days never expire
  prorate_first_year     BOOLEAN NOT NULL DEFAULT true,  -- reserved, see migration_v9 note
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             UUID REFERENCES public.profiles(id)
);
DROP TRIGGER IF EXISTS leave_policies_updated_at ON public.leave_policies;
CREATE TRIGGER leave_policies_updated_at BEFORE UPDATE ON public.leave_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

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

-- Office-scoped through the category (leave_policies itself has no
-- office_id — its office is derived).
DROP POLICY IF EXISTS "leave_policies_read" ON public.leave_policies;
CREATE POLICY "leave_policies_read" ON public.leave_policies
  FOR SELECT USING (
    (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
    AND EXISTS (
      SELECT 1 FROM public.leave_categories c
       WHERE c.id = category_id AND public.can_see_office(c.office_id)
    )
  );

DROP POLICY IF EXISTS "leave_cycle_grants_read_own"        ON public.leave_cycle_grants;
DROP POLICY IF EXISTS "leave_cycle_grants_read_privileged" ON public.leave_cycle_grants;
CREATE POLICY "leave_cycle_grants_read_own" ON public.leave_cycle_grants
  FOR SELECT USING (auth.uid() = employee_id);
CREATE POLICY "leave_cycle_grants_read_privileged" ON public.leave_cycle_grants
  FOR SELECT USING (
    (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

-- Holiday / weekend calendars. weekend_days uses Postgres DOW (0=Sun … 6=Sat).
-- Company default is Friday/Saturday = {5,6}.
CREATE TABLE IF NOT EXISTS public.holiday_calendars (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  weekend_days INT[] NOT NULL DEFAULT '{5,6}',
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Calendars are tied 1:1 to an office (see migration_v10); emp_calendar()
-- resolves through this instead of calendar_assignments below.
ALTER TABLE public.holiday_calendars
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_office ON public.holiday_calendars(office_id);

-- One calendar per employee (multi-select assignment expands to rows here).
-- Unassigned employees fall back to the default calendar.
CREATE TABLE IF NOT EXISTS public.calendar_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id UUID NOT NULL REFERENCES public.holiday_calendars(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.profiles(id)          ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id)
);

CREATE TABLE IF NOT EXISTS public.public_holidays (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id UUID NOT NULL REFERENCES public.holiday_calendars(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (calendar_id, date)
);

-- Seed a single default calendar (Fri/Sat weekend).
INSERT INTO public.holiday_calendars (name, weekend_days, is_default)
SELECT 'Company Default', '{5,6}', true
WHERE NOT EXISTS (SELECT 1 FROM public.holiday_calendars WHERE is_default);

CREATE INDEX IF NOT EXISTS idx_cal_assign_employee ON public.calendar_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_public_holidays_cal ON public.public_holidays(calendar_id, date);

-- updated_at triggers
DROP TRIGGER IF EXISTS leave_categories_updated_at ON public.leave_categories;
CREATE TRIGGER leave_categories_updated_at BEFORE UPDATE ON public.leave_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS leave_requests_updated_at ON public.leave_requests;
CREATE TRIGGER leave_requests_updated_at BEFORE UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS holiday_calendars_updated_at ON public.holiday_calendars;
CREATE TRIGGER holiday_calendars_updated_at BEFORE UPDATE ON public.holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------
-- CALENDAR / WORKING-DAY HELPERS
-- ---------------------------------------------------------------

-- Resolve an employee's effective calendar via their HOME office, falling
-- back to the default calendar (e.g. an office created without
-- upsert_office ever provisioning one). calendar_assignments is no longer
-- consulted — the table/RLS/RPC stay in place but unused (see migration_v10).
CREATE OR REPLACE FUNCTION public.emp_calendar(emp UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT hc.id FROM public.holiday_calendars hc
       JOIN public.profiles p ON p.office_id = hc.office_id
      WHERE p.id = emp),
    (SELECT id FROM public.holiday_calendars WHERE is_default LIMIT 1)
  );
$$;

-- True when the date is a normal working day for that employee
-- (not a weekend per their calendar, not a public holiday).
CREATE OR REPLACE FUNCTION public.is_working_day(emp UUID, d DATE)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cal UUID; v_weekend INT[];
BEGIN
  v_cal := public.emp_calendar(emp);
  IF v_cal IS NULL THEN
    RETURN EXTRACT(DOW FROM d)::INT NOT IN (5,6);   -- fallback Fri/Sat
  END IF;
  SELECT weekend_days INTO v_weekend FROM public.holiday_calendars WHERE id = v_cal;
  IF EXTRACT(DOW FROM d)::INT = ANY(v_weekend) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.public_holidays WHERE calendar_id = v_cal AND date = d) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- Count working days in an inclusive date range for an employee.
CREATE OR REPLACE FUNCTION public.leave_working_days(emp UUID, d_start DATE, d_end DATE)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*)::NUMERIC
  FROM generate_series(d_start, d_end, INTERVAL '1 day') AS g(d)
  WHERE public.is_working_day(emp, g.d::DATE);
$$;

-- ---------------------------------------------------------------
-- DAILY TIMESHEET REMINDERS — backing functions for the scheduled job
-- (see netlify/functions/daily-timesheet-reminders.js). Both return
-- cross-employee, cross-office data assembled for the service-role job
-- and are REVOKEd from anon/authenticated below.
-- ---------------------------------------------------------------

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

-- Who's due a mail right now. Send time is the RECIPIENT's own
-- home-office local hour — not the hour of whichever office(s) their
-- digest happens to cover. An office-centric job would mail a
-- New-York-based HR user their Dubai section at 01:00 EDT, and send a
-- second, separate email per office. One row per person.
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

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and Postgres
-- privilege checks are additive across direct grants, role membership AND
-- PUBLIC — revoking from anon/authenticated alone leaves the PUBLIC grant
-- standing, so ANY authenticated user could call these via PostgREST RPC
-- and read every employee's name, email, office and attendance gaps. Must
-- revoke from PUBLIC itself; service_role bypasses grants entirely, so the
-- reminder job is unaffected.
REVOKE EXECUTE ON FUNCTION public.timesheet_status_report(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reminder_recipients(INT)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.visible_office_ids_for(UUID) FROM PUBLIC;

-- Composite index backing timesheet_status_report()'s problem_days
-- correlated subquery — one `WHERE employee_id = ... AND date = ...`
-- lookup per employee-day in the backlog window. Only single-column
-- indexes on employee_id and date existed before this.
CREATE INDEX IF NOT EXISTS idx_timesheets_employee_date
  ON public.timesheets (employee_id, date);

-- Lets an IT admin see reminder run history. reminder_log has RLS enabled
-- with NO policies (by design), so it's invisible even to IT through
-- PostgREST directly — this wraps it in a SECURITY DEFINER function gated
-- by an internal my_has_role('it') check, the same pattern upsert_office
-- uses. No REVOKE needed: the internal check is what actually gates
-- access, not the grant.
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

-- ---------------------------------------------------------------
-- TIMESHEET BLOCKING TRIGGERS (enforced for every write path,
-- including the service-role Netlify upload)
-- ---------------------------------------------------------------

-- Daily leaves block a whole working day.
CREATE OR REPLACE FUNCTION public.block_timesheet_on_leave()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.is_working_day(NEW.employee_id, NEW.date)
     AND EXISTS (
       SELECT 1 FROM public.leave_requests lr
       WHERE lr.employee_id = NEW.employee_id
         AND lr.status = 'approved'
         AND lr.unit = 'daily'
         AND NEW.date BETWEEN lr.start_date AND lr.end_date
     ) THEN
    RAISE EXCEPTION 'You have an approved leave for this date range. Please adjust your timesheet entries.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS timesheets_block_on_leave ON public.timesheets;
CREATE TRIGGER timesheets_block_on_leave
  BEFORE INSERT ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.block_timesheet_on_leave();

-- Hourly leaves block only overlapping entry time windows on that date.
CREATE OR REPLACE FUNCTION public.block_entry_on_hourly_leave()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp UUID; v_date DATE;
BEGIN
  IF NEW.time_from IS NULL OR NEW.time_to IS NULL THEN RETURN NEW; END IF;
  SELECT employee_id, date INTO v_emp, v_date FROM public.timesheets WHERE id = NEW.timesheet_id;
  IF EXISTS (
    SELECT 1 FROM public.leave_requests lr
    WHERE lr.employee_id = v_emp
      AND lr.status = 'approved'
      AND lr.unit = 'hourly'
      AND lr.start_date = v_date
      AND lr.start_time < NEW.time_to
      AND lr.end_time   > NEW.time_from
  ) THEN
    RAISE EXCEPTION 'You have an approved leave for this date range. Please adjust your timesheet entries.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entries_block_on_hourly_leave ON public.timesheet_entries;
CREATE TRIGGER entries_block_on_hourly_leave
  BEFORE INSERT ON public.timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION public.block_entry_on_hourly_leave();

-- ---------------------------------------------------------------
-- REQUEST WORKFLOW RPCs (state machine + permissions centralised)
-- ---------------------------------------------------------------

-- Notify everyone holding the HR approval (or IT) flag.
CREATE OR REPLACE FUNCTION public.notify_hr_approvers(p_message TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.notifications (user_id, type, message)
  SELECT id, 'leave', p_message FROM public.profiles
  WHERE 'hr_approve_requests' = ANY(roles) OR 'it' = ANY(roles);
$$;

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

  -- Category gate (see migration_v11): must exist, be active, and belong
  -- to the submitter's HOME office. SECURITY DEFINER bypasses RLS, so this
  -- is the only enforcement point — additional_office_ids/sees_all_offices
  -- grant administrative visibility, not the right to book another
  -- office's leave against your own balance.
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

CREATE OR REPLACE FUNCTION public.decide_leave_request(
  p_id UUID, p_approve BOOLEAN, p_reason TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.leave_requests; v_uid UUID := auth.uid(); v_name TEXT;
BEGIN
  SELECT * INTO r FROM public.leave_requests WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.'; END IF;
  SELECT COALESCE(full_name, email) INTO v_name FROM public.profiles WHERE id = r.employee_id;

  IF r.status = 'pending_manager' THEN
    IF NOT (public.i_manage(r.employee_id) OR public.my_has_role('it')) THEN
      RAISE EXCEPTION 'Not authorized to approve at this stage.';
    END IF;
    IF p_approve THEN
      UPDATE public.leave_requests
        SET status = 'pending_hr', tier1_approver_id = v_uid, tier1_at = NOW() WHERE id = p_id;
      PERFORM public.notify_hr_approvers(v_name || ' leave request approved by line manager — needs HR sign-off.');
      INSERT INTO public.notifications (user_id, type, message)
        VALUES (r.employee_id, 'leave', 'Your leave request was approved by your line manager and sent to HR.');
    ELSE
      UPDATE public.leave_requests
        SET status = 'rejected', tier1_approver_id = v_uid, tier1_at = NOW(),
            rejection_reason = NULLIF(trim(p_reason), '') WHERE id = p_id;
      INSERT INTO public.notifications (user_id, type, message)
        VALUES (r.employee_id, 'leave', 'Your leave request was rejected by your line manager.');
    END IF;

  ELSIF r.status = 'pending_hr' THEN
    IF NOT (public.my_has_role('hr_approve_requests') OR public.my_has_role('it')) THEN
      RAISE EXCEPTION 'Not authorized to approve at this stage.';
    END IF;
    IF p_approve THEN
      UPDATE public.leave_requests
        SET status = 'approved', hr_approver_id = v_uid, hr_at = NOW() WHERE id = p_id;
      INSERT INTO public.notifications (user_id, type, message)
        VALUES (r.employee_id, 'leave', 'Your leave request has been fully approved.');
    ELSE
      UPDATE public.leave_requests
        SET status = 'rejected', hr_approver_id = v_uid, hr_at = NOW(),
            rejection_reason = NULLIF(trim(p_reason), '') WHERE id = p_id;
      INSERT INTO public.notifications (user_id, type, message)
        VALUES (r.employee_id, 'leave', 'Your leave request was rejected by HR.');
    END IF;
  ELSE
    RAISE EXCEPTION 'This request is no longer pending.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_leave_request(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.leave_requests
    SET status = 'cancelled'
    WHERE id = p_id AND employee_id = auth.uid()
      AND status IN ('pending_manager', 'pending_hr');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only your own requests that are still pending can be withdrawn.';
  END IF;
END;
$$;

-- IT-only: revoke a fully approved leave. Balance is restored automatically
-- (revoked rows are excluded from the usage sum) and the dates unblock.
CREATE OR REPLACE FUNCTION public.revoke_leave_request(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.leave_requests;
BEGIN
  IF NOT public.my_has_role('it') THEN RAISE EXCEPTION 'Only IT can revoke approved leaves.'; END IF;
  SELECT * INTO r FROM public.leave_requests WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.'; END IF;
  IF r.status <> 'approved' THEN RAISE EXCEPTION 'Only approved leaves can be revoked.'; END IF;
  UPDATE public.leave_requests
    SET status = 'revoked', revoked_by = auth.uid(), revoked_at = NOW() WHERE id = p_id;
  INSERT INTO public.notifications (user_id, type, message)
    VALUES (r.employee_id, 'leave', 'A previously approved leave was revoked by IT.');
END;
$$;

-- HR sets / updates the allowance for one or many employees at once.
-- Overwrites the absolute total — use for corrections or initial grants.
CREATE OR REPLACE FUNCTION public.set_leave_balance(
  p_employees UUID[], p_category UUID, p_allowance NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_office UUID; v_bad INT;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  -- Existence before visibility: a missing category yields NULL, and
  -- can_see_office(NULL) is TRUE by design, so checking visibility first
  -- would wave through a garbage category id.
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

-- HR adds to / subtracts from the existing allowance for one or many employees
-- at once (e.g. "+20 annual days" without needing to know anyone's running
-- total). The addition happens in SQL against the stored row, not a value
-- read back into the client, so concurrent adjustments can't clobber each
-- other. Clamped at 0 — a subtraction can never drive a balance negative.
-- This is the seam a future accrual/rollover engine would also write through.
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

-- HR/IT assigns one or many employees to a calendar.
CREATE OR REPLACE FUNCTION public.assign_calendar(p_employees UUID[], p_calendar UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.my_has_role('hr_manage_calendar') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  INSERT INTO public.calendar_assignments (employee_id, calendar_id)
  SELECT unnest(p_employees), p_calendar
  ON CONFLICT (employee_id) DO UPDATE SET calendar_id = EXCLUDED.calendar_id;
END;
$$;

-- ---------------------------------------------------------------
-- LEAVE CYCLE ENGINE (see migration_v9)
-- ---------------------------------------------------------------

-- Most recent anniversary of p_joining on or before p_today.
CREATE OR REPLACE FUNCTION public.leave_cycle_start(p_joining DATE, p_today DATE)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (p_joining + ((date_part('year', age(p_today, p_joining)))::int || ' years')::interval)::date <= p_today
    THEN (p_joining + ((date_part('year', age(p_today, p_joining)))::int || ' years')::interval)::date
    ELSE (p_joining + ((date_part('year', age(p_today, p_joining)))::int - 1 || ' years')::interval)::date
  END;
$$;

-- HR: create/update a category's leave policy.
CREATE OR REPLACE FUNCTION public.upsert_leave_policy(
  p_category UUID, p_default_days NUMERIC, p_rollover_enabled BOOLEAN,
  p_rollover_cap NUMERIC, p_rollover_expiry_months INT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID; v_office UUID;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  -- The policy's office is derived from its category (leave_policies has
  -- no office_id of its own), so only a visibility check is needed here.
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

-- HR / Employee Overview: set an employee's joining date.
CREATE OR REPLACE FUNCTION public.set_joining_date(p_employees UUID[], p_date DATE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.my_has_role('employee_overview') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  UPDATE public.profiles SET joining_date = p_date, updated_at = NOW() WHERE id = ANY(p_employees);
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

      -- Carry-in based on the LIVE balance (so manual HR adjustments made
      -- mid-cycle are respected, not wiped out by the rollover), minus what
      -- was actually used during the previous cycle window.
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

-- Claw back the unused portion of any carried-in balance whose expiry date
-- has passed. HR/IT only — scoped to offices the caller can see (was
-- company-wide regardless of caller's office; closed alongside the rest of
-- the per-office pass in migration_v11). Idempotent via carry_expired_at.
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

-- ---------------------------------------------------------------
-- BALANCE SUMMARY VIEW (security_invoker = respects caller RLS)
-- "used" is cycle-scoped for employees with a joining_date (see
-- migration_v9); employees without one keep the old lifetime-cumulative
-- behaviour unchanged.
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

-- ---------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------
ALTER TABLE public.leave_categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_balances       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holiday_calendars    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_holidays      ENABLE ROW LEVEL SECURITY;

-- ---- LEAVE CATEGORIES ---- (per-office, see migration_v11)
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

-- ---- LEAVE BALANCES ---- (own + privileged read; writes via RPC only)
DROP POLICY IF EXISTS "leave_bal_read_own"        ON public.leave_balances;
DROP POLICY IF EXISTS "leave_bal_read_privileged" ON public.leave_balances;
CREATE POLICY "leave_bal_read_own" ON public.leave_balances
  FOR SELECT USING (employee_id = auth.uid());
CREATE POLICY "leave_bal_read_privileged" ON public.leave_balances
  FOR SELECT USING (
    (public.has_any_hr_flag() OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

-- ---- LEAVE REQUESTS ---- (reads; all writes go through SECURITY DEFINER RPCs)
DROP POLICY IF EXISTS "leave_req_read_own"        ON public.leave_requests;
DROP POLICY IF EXISTS "leave_req_read_manager"    ON public.leave_requests;
DROP POLICY IF EXISTS "leave_req_read_privileged" ON public.leave_requests;
CREATE POLICY "leave_req_read_own" ON public.leave_requests
  FOR SELECT USING (employee_id = auth.uid());
CREATE POLICY "leave_req_read_manager" ON public.leave_requests
  FOR SELECT USING (
    public.i_manage(employee_id)
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );
CREATE POLICY "leave_req_read_privileged" ON public.leave_requests
  FOR SELECT USING (
    (public.has_any_hr_flag() OR public.my_has_role('it'))
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
  );

-- ---- CALENDARS / HOLIDAYS ---- (readable by all authenticated; HR/IT manage)
DROP POLICY IF EXISTS "cal_read"   ON public.holiday_calendars;
DROP POLICY IF EXISTS "cal_manage" ON public.holiday_calendars;
CREATE POLICY "cal_read" ON public.holiday_calendars
  FOR SELECT USING (auth.uid() IS NOT NULL AND public.can_see_office(office_id));
CREATE POLICY "cal_manage" ON public.holiday_calendars
  FOR ALL USING (public.my_has_role('hr_manage_calendar') OR public.my_has_role('it'))
  WITH CHECK (public.my_has_role('hr_manage_calendar') OR public.my_has_role('it'));

DROP POLICY IF EXISTS "holidays_read"   ON public.public_holidays;
DROP POLICY IF EXISTS "holidays_manage" ON public.public_holidays;
CREATE POLICY "holidays_read" ON public.public_holidays
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.holiday_calendars hc WHERE hc.id = calendar_id AND public.can_see_office(hc.office_id))
  );
CREATE POLICY "holidays_manage" ON public.public_holidays
  FOR ALL USING (public.my_has_role('hr_manage_calendar') OR public.my_has_role('it'))
  WITH CHECK (public.my_has_role('hr_manage_calendar') OR public.my_has_role('it'));

DROP POLICY IF EXISTS "cal_assign_read_own"        ON public.calendar_assignments;
DROP POLICY IF EXISTS "cal_assign_read_privileged" ON public.calendar_assignments;
DROP POLICY IF EXISTS "cal_assign_manage"          ON public.calendar_assignments;
CREATE POLICY "cal_assign_read_own" ON public.calendar_assignments
  FOR SELECT USING (employee_id = auth.uid());
CREATE POLICY "cal_assign_read_privileged" ON public.calendar_assignments
  FOR SELECT USING (
    public.my_has_role('hr_manage_calendar') OR public.my_has_role('employee_overview') OR public.my_has_role('it')
  );
CREATE POLICY "cal_assign_manage" ON public.calendar_assignments
  FOR ALL USING (public.my_has_role('hr_manage_calendar') OR public.my_has_role('it'))
  WITH CHECK (public.my_has_role('hr_manage_calendar') OR public.my_has_role('it'));

-- ---------------------------------------------------------------
-- EXTEND EXISTING-TABLE READ ACCESS FOR THE GRANULAR HR FLAGS
-- (the legacy 'hr' role already had these; the new flag holders need
--  the same reads to power the HR Panel)
-- ---------------------------------------------------------------

-- Helper: holds any HR-panel flag
CREATE OR REPLACE FUNCTION public.has_any_hr_flag()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_has_role('hr_view_timesheets')
      OR public.my_has_role('hr_manage_policies')
      OR public.my_has_role('hr_manage_calendar')
      OR public.my_has_role('hr_approve_requests')
      OR public.my_has_role('employee_overview');
$$;

-- Project memberships readable by HR-flag holders (Employee Overview needs this).
-- The office check goes through this SECURITY DEFINER helper rather than a
-- direct `FROM public.projects` in the policy body — projects' own
-- "projects_read_member" policy reads project_members right back, so a
-- direct reference here would re-trigger projects' RLS, which re-triggers
-- this policy, forming a cycle Postgres rejects with 42P17 "infinite
-- recursion detected in policy for relation projects". A function body
-- runs as its owner and bypasses RLS on the table it reads, same as
-- can_see_office()/my_has_role() already do for profiles.
CREATE OR REPLACE FUNCTION public.project_office_id(p_project UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT office_id FROM public.projects WHERE id = p_project;
$$;

DROP POLICY IF EXISTS "members_read_privileged" ON public.project_members;
CREATE POLICY "members_read_privileged" ON public.project_members
  FOR SELECT USING (
    public.has_any_hr_flag()
    AND public.can_see_office(public.project_office_id(project_id))
  );

-- Profiles: any HR-flag holder can read all profiles (employee pickers, names)
DROP POLICY IF EXISTS "profiles_read_hr_flags" ON public.profiles;
CREATE POLICY "profiles_read_hr_flags" ON public.profiles
  FOR SELECT USING (public.has_any_hr_flag() AND public.can_see_office(office_id));

-- Timesheets + entries: the timesheet-view flag can read all
DROP POLICY IF EXISTS "timesheets_read_hr_view" ON public.timesheets;
CREATE POLICY "timesheets_read_hr_view" ON public.timesheets
  FOR SELECT USING (
    public.my_has_role('hr_view_timesheets')
    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = employee_id AND public.can_see_office(pr.office_id))
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

-- Projects + stages: HR-flag holders can read the catalogue for filters/labels
DROP POLICY IF EXISTS "projects_read_hr_flags" ON public.projects;
CREATE POLICY "projects_read_hr_flags" ON public.projects
  FOR SELECT USING (public.has_any_hr_flag() AND public.can_see_office(office_id));

DROP POLICY IF EXISTS "stages_read_hr_flags" ON public.project_stages;
CREATE POLICY "stages_read_hr_flags" ON public.project_stages
  FOR SELECT USING (
    public.has_any_hr_flag()
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND public.can_see_office(p.office_id))
  );

-- Analytics roles can read the project/stage catalogue (for the Projects
-- analytics tab). Timesheet-entry reads are already governed for these roles.
DROP POLICY IF EXISTS "projects_read_analytics" ON public.projects;
CREATE POLICY "projects_read_analytics" ON public.projects
  FOR SELECT USING (
    (public.my_has_role('global_analytics') OR public.my_has_role('team_analytics'))
    AND public.can_see_office(office_id)
  );

DROP POLICY IF EXISTS "stages_read_analytics" ON public.project_stages;
CREATE POLICY "stages_read_analytics" ON public.project_stages
  FOR SELECT USING (
    (public.my_has_role('global_analytics') OR public.my_has_role('team_analytics'))
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND public.can_see_office(p.office_id))
  );

-- ===============================================================
-- PROJECT CONSTRAINTS & GOVERNANCE ENGINE
-- Projects are either DATE-tracked (timeline) or HOURS-tracked (pool).
-- Hard enforcement at write time (no grace period):
--   DATE  — an entry dated D is loggable iff start_date ≤ D ≤ end_date.
--           D < start_date → blocked ("not opened, contact line manager");
--           D > end_date   → blocked (future-dated work); backdating within
--           the window stays open indefinitely.
--   HOURS — loggable while the pool has room. Pool exhausted → blocked for
--           every date; an entry exceeding the remaining pool is rejected
--           (the employee reduces it or requests an extension).
-- Mirrored by src/lib/projectRules.js and netlify/functions/parse-timesheet.js.
-- ===============================================================

-- ===============================================================
-- DISCIPLINES (managed list + per-entry discipline)
-- Employees pick a discipline once at onboarding; only Policies/IT
-- may change it thereafter. Every timesheet entry carries a
-- discipline (defaults to the employee's home discipline but may
-- differ, for cross-discipline cost analytics).
-- ===============================================================
CREATE TABLE IF NOT EXISTS public.disciplines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_disciplines_name_lower ON public.disciplines(lower(name));

DROP TRIGGER IF EXISTS disciplines_updated_at ON public.disciplines;
CREATE TRIGGER disciplines_updated_at BEFORE UPDATE ON public.disciplines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS discipline_id UUID REFERENCES public.disciplines(id) ON DELETE SET NULL;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS discipline;

ALTER TABLE public.disciplines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "disciplines_read"   ON public.disciplines;
DROP POLICY IF EXISTS "disciplines_manage" ON public.disciplines;
CREATE POLICY "disciplines_read" ON public.disciplines
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "disciplines_manage" ON public.disciplines
  FOR ALL USING (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
  WITH CHECK (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'));

-- Set-once for employees; HR/IT may change anytime.
CREATE OR REPLACE FUNCTION public.guard_discipline_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.discipline_id IS DISTINCT FROM OLD.discipline_id THEN
    IF public.my_has_role('hr_manage_policies') OR public.my_has_role('it') THEN
      RETURN NEW;
    END IF;
    IF OLD.discipline_id IS NOT NULL THEN
      RAISE EXCEPTION 'Your discipline can only be changed by HR or IT.';
    END IF;
    IF auth.uid() <> NEW.id THEN
      RAISE EXCEPTION 'Not authorized to set this discipline.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS profiles_guard_discipline ON public.profiles;
CREATE TRIGGER profiles_guard_discipline BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_discipline_change();

CREATE OR REPLACE FUNCTION public.require_entry_discipline()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.discipline_id IS NULL THEN
    RAISE EXCEPTION 'Every timesheet entry must have a discipline.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS entries_require_discipline ON public.timesheet_entries;
CREATE TRIGGER entries_require_discipline BEFORE INSERT ON public.timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION public.require_entry_discipline();

CREATE OR REPLACE FUNCTION public.upsert_discipline(p_id UUID, p_name TEXT, p_active BOOLEAN)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'Discipline name is required.'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.disciplines (name, is_active, created_by)
      VALUES (btrim(p_name), COALESCE(p_active, true), auth.uid())
      RETURNING id INTO v_id;
  ELSE
    UPDATE public.disciplines
      SET name = btrim(p_name), is_active = COALESCE(p_active, is_active), updated_at = NOW()
      WHERE id = p_id
      RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Discipline not found.'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_employee_discipline(p_employees UUID[], p_discipline UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  UPDATE public.profiles SET discipline_id = p_discipline, updated_at = NOW()
    WHERE id = ANY(p_employees);
END;
$$;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS tracking_type project_tracking_type NOT NULL DEFAULT 'date',
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS end_date   DATE,
  ADD COLUMN IF NOT EXISTS total_hours NUMERIC(10,2),
  -- Hour-pool tracking is retired (see migration_v7) — tracking_type/total_hours
  -- are retained on the table but every project is date-tracked going forward.
  ADD COLUMN IF NOT EXISTS needs_date_review BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.project_stages
  ADD COLUMN IF NOT EXISTS tracking_state  stage_state NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS allocated_hours NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS soft_closed_at  TIMESTAMPTZ;

ALTER TABLE public.timesheet_entries
  ADD COLUMN IF NOT EXISTS is_over_budget BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discipline_id  UUID REFERENCES public.disciplines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_timesheet_entries_discipline ON public.timesheet_entries(discipline_id);

-- ---------------------------------------------------------------
-- IMMUTABLE BOUNDARY AUDIT LOG
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  stage_id    UUID REFERENCES public.project_stages(id) ON DELETE SET NULL,
  changed_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  field       TEXT NOT NULL,        -- e.g. 'project.end_date', 'stage.allocated_hours'
  old_value   TEXT,
  new_value   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_audit_project ON public.project_audit_logs(project_id, created_at DESC);

ALTER TABLE public.project_audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_read" ON public.project_audit_logs;
CREATE POLICY "audit_read" ON public.project_audit_logs
  FOR SELECT USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
-- Writes happen only inside SECURITY DEFINER RPCs; no INSERT/UPDATE/DELETE policy
-- (the table is append-only and immutable from the client's perspective).

-- ---------------------------------------------------------------
-- tracking_type lock — RETIRED (see migration_v7).
-- Used to block switching an existing project between 'hours' and 'date'.
-- Now redundant: create_project() forces every new project to 'date', so
-- tracking_type never changes post-creation regardless. Keeping the trigger
-- would only block the v7 backfill UPDATE that converts legacy 'hours' rows.
-- ---------------------------------------------------------------
DROP TRIGGER IF EXISTS projects_lock_tracking_type ON public.projects;
DROP FUNCTION IF EXISTS public.lock_project_tracking_type();

-- ---------------------------------------------------------------
-- PREVENT DELETION of projects/stages with APPROVED timesheet data
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_delete_project_with_approved()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.timesheet_entries e
    JOIN public.timesheets t ON t.id = e.timesheet_id
    WHERE e.project_id = OLD.id AND t.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Cannot delete project "%": it has approved timesheet entries. Archive it instead.', OLD.name;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS projects_prevent_delete ON public.projects;
CREATE TRIGGER projects_prevent_delete
  BEFORE DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.prevent_delete_project_with_approved();

CREATE OR REPLACE FUNCTION public.prevent_delete_stage_with_approved()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.timesheet_entries e
    JOIN public.timesheets t ON t.id = e.timesheet_id
    WHERE e.stage_id = OLD.id AND t.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Cannot delete stage "%": it has approved timesheet entries. Archive it instead.', OLD.name;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS stages_prevent_delete ON public.project_stages;
CREATE TRIGGER stages_prevent_delete
  BEFORE DELETE ON public.project_stages
  FOR EACH ROW EXECUTE FUNCTION public.prevent_delete_stage_with_approved();

-- ---------------------------------------------------------------
-- COMPUTED STAGE STATE + LOGGED HOURS
-- ---------------------------------------------------------------

-- Cumulative hours logged to a stage (approved + pending). SECURITY DEFINER so
-- it reports the true total regardless of the caller's row visibility.
CREATE OR REPLACE FUNCTION public.stage_logged_hours(p_stage UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(e.hours_decimal), 0)
  FROM public.timesheet_entries e
  JOIN public.timesheets t ON t.id = e.timesheet_id
  WHERE e.stage_id = p_stage AND t.status IN ('pending', 'approved');
$$;

-- Stages with computed lifecycle state + logged hours, for display.
-- Every stage is date-tracked now (see migration_v7); logged_hours is kept as
-- a plain "actual hours worked" figure for analytics, with no pool to compare against.
DROP VIEW IF EXISTS public.project_stages_view;
CREATE VIEW public.project_stages_view WITH (security_invoker = true) AS
SELECT
  s.*,
  p.tracking_type,
  h.logged AS logged_hours,
  CASE
    WHEN s.start_date IS NOT NULL AND CURRENT_DATE < s.start_date THEN 'not_started'
    WHEN s.end_date   IS NOT NULL AND CURRENT_DATE > s.end_date   THEN 'ended'
    ELSE 'active'
  END AS effective_state
FROM public.project_stages s
JOIN public.projects p ON p.id = s.project_id
LEFT JOIN LATERAL (SELECT public.stage_logged_hours(s.id) AS logged) h ON true;

-- ---------------------------------------------------------------
-- WRITE-TIME ENFORCEMENT (lifecycle + grace + overrun)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_stage_logging()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_proj  public.projects%ROWTYPE;
  v_stage public.project_stages%ROWTYPE;
  v_date  DATE;
BEGIN
  -- A task description is mandatory for every entry (in-app and Excel alike).
  IF NEW.task IS NULL OR btrim(NEW.task) = '' THEN
    RAISE EXCEPTION 'Every timesheet entry must include a task description.';
  END IF;

  -- A stage is required whenever an entry references a project.
  IF NEW.stage_id IS NULL THEN
    IF NEW.project_id IS NOT NULL THEN
      RAISE EXCEPTION 'Selecting a stage is required.';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO v_stage FROM public.project_stages WHERE id = NEW.stage_id;
  SELECT * INTO v_proj  FROM public.projects       WHERE id = v_stage.project_id;
  SELECT date INTO v_date FROM public.timesheets   WHERE id = NEW.timesheet_id;

  -- Not opened yet: entry dated before the stage start.
  IF v_stage.start_date IS NOT NULL AND v_date < v_stage.start_date THEN
    RAISE EXCEPTION 'Stage "%" has not opened yet (starts %). Contact your line manager.', v_stage.name, v_stage.start_date;
  END IF;
  -- Ended: forward-dated work past the end is blocked; backdating within
  -- the window stays open indefinitely (no grace / hard-lock tail), unless extended.
  IF v_stage.end_date IS NOT NULL AND v_date > v_stage.end_date THEN
    RAISE EXCEPTION 'Stage "%" ended on %. You can only log work dated on or before that.', v_stage.name, v_stage.end_date;
  END IF;

  NEW.is_over_budget := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entries_enforce_stage ON public.timesheet_entries;
CREATE TRIGGER entries_enforce_stage
  BEFORE INSERT ON public.timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stage_logging();

-- Hour-pool exhaustion notification is retired along with hour-pool tracking.
DROP TRIGGER IF EXISTS entries_after_hours_close ON public.timesheet_entries;
DROP FUNCTION IF EXISTS public.after_entry_hours_close();

-- ---------------------------------------------------------------
-- BOUNDARY RPCs (transactional: validation + audit + mutation together)
-- ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_manage_projects()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_has_role('projects_control') OR public.my_has_role('it');
$$;

-- Create a project. Date-tracked only — hour-pool tracking is retired.
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

  -- New projects take the creator's home office.
  SELECT office_id INTO v_office FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.projects (name, description, tracking_type, start_date, end_date, total_hours, created_by, office_id)
  VALUES (p_name, NULLIF(trim(p_description), ''), 'date', p_start, p_end, NULL, auth.uid(), v_office)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Update a project's boundary (dates) with audit + validation.
CREATE OR REPLACE FUNCTION public.update_project_boundary(
  p_project UUID, p_start DATE, p_end DATE, p_total_hours NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p public.projects%ROWTYPE;
BEGIN
  IF NOT public.can_manage_projects() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  SELECT * INTO v_p FROM public.projects WHERE id = p_project;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project not found.'; END IF;

  IF p_start IS NULL THEN RAISE EXCEPTION 'Start date is required.'; END IF;
  IF p_end IS NOT NULL AND p_end < p_start THEN RAISE EXCEPTION 'End date cannot be before start date.'; END IF;
  -- end date cannot precede the latest stage end
  IF p_end IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.project_stages WHERE project_id = p_project AND end_date > p_end
  ) THEN
    RAISE EXCEPTION 'Project end date cannot be earlier than a stage end date. Adjust the stages first.';
  END IF;
  IF v_p.start_date IS DISTINCT FROM p_start THEN
    INSERT INTO public.project_audit_logs (project_id, changed_by, field, old_value, new_value)
    VALUES (p_project, auth.uid(), 'project.start_date', v_p.start_date::text, p_start::text);
  END IF;
  IF v_p.end_date IS DISTINCT FROM p_end THEN
    INSERT INTO public.project_audit_logs (project_id, changed_by, field, old_value, new_value)
    VALUES (p_project, auth.uid(), 'project.end_date', v_p.end_date::text, p_end::text);
  END IF;
  UPDATE public.projects
    SET start_date = p_start, end_date = p_end,
        -- Clears only once a real end date is actually set — re-saving with
        -- end_date still NULL should not silently dismiss the review flag.
        needs_date_review = CASE WHEN p_end IS NOT NULL THEN false ELSE needs_date_review END
    WHERE id = p_project;
END;
$$;

-- Create a stage (validates parent-child date boundaries).
CREATE OR REPLACE FUNCTION public.create_stage(
  p_project UUID, p_name TEXT, p_start DATE, p_end DATE, p_allocated NUMERIC, p_order INT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p public.projects%ROWTYPE; v_id UUID;
BEGIN
  IF NOT public.can_manage_projects() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  SELECT * INTO v_p FROM public.projects WHERE id = p_project;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project not found.'; END IF;

  IF p_start IS NULL THEN RAISE EXCEPTION 'A stage start date is required.'; END IF;
  IF p_end IS NOT NULL AND p_end < p_start THEN RAISE EXCEPTION 'Stage end date cannot be before its start date.'; END IF;
  IF v_p.start_date IS NOT NULL AND p_start < v_p.start_date THEN
    RAISE EXCEPTION 'Stage start (%) is before the project start (%).', p_start, v_p.start_date;
  END IF;
  IF v_p.end_date IS NOT NULL AND p_end IS NOT NULL AND p_end > v_p.end_date THEN
    RAISE EXCEPTION 'Stage end (%) is beyond the project end (%). Extend the project first.', p_end, v_p.end_date;
  END IF;

  INSERT INTO public.project_stages (project_id, name, start_date, end_date, allocated_hours, order_index, created_by)
  VALUES (p_project, p_name, p_start, p_end, NULL, COALESCE(p_order, 0), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Update a stage boundary (dates) with audit, and optional auto-extend of
-- the parent project's end date.
CREATE OR REPLACE FUNCTION public.update_stage_boundary(
  p_stage UUID, p_start DATE, p_end DATE, p_allocated NUMERIC, p_confirm_extend BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_s public.project_stages%ROWTYPE; v_p public.projects%ROWTYPE;
BEGIN
  IF NOT public.can_manage_projects() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  SELECT * INTO v_s FROM public.project_stages WHERE id = p_stage;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage not found.'; END IF;
  SELECT * INTO v_p FROM public.projects WHERE id = v_s.project_id;

  IF p_start IS NULL THEN RAISE EXCEPTION 'A stage start date is required.'; END IF;
  IF p_end IS NOT NULL AND p_end < p_start THEN RAISE EXCEPTION 'Stage end date cannot be before its start date.'; END IF;
  IF v_p.start_date IS NOT NULL AND p_start < v_p.start_date THEN
    RAISE EXCEPTION 'Stage start (%) is before the project start (%).', p_start, v_p.start_date;
  END IF;
  -- Extending beyond the project end: allow only with confirmation, then push project end out.
  IF p_end IS NOT NULL AND v_p.end_date IS NOT NULL AND p_end > v_p.end_date THEN
    IF NOT COALESCE(p_confirm_extend, false) THEN
      RAISE EXCEPTION 'CONFIRM_EXTEND: this extends the stage beyond the project end (%). Confirm to push the project deadline to %.', v_p.end_date, p_end;
    END IF;
    INSERT INTO public.project_audit_logs (project_id, stage_id, changed_by, field, old_value, new_value)
    VALUES (v_p.id, p_stage, auth.uid(), 'project.end_date', v_p.end_date::text, p_end::text);
    UPDATE public.projects SET end_date = p_end WHERE id = v_p.id;
  END IF;
  IF v_s.start_date IS DISTINCT FROM p_start THEN
    INSERT INTO public.project_audit_logs (project_id, stage_id, changed_by, field, old_value, new_value)
    VALUES (v_p.id, p_stage, auth.uid(), 'stage.start_date', v_s.start_date::text, p_start::text);
  END IF;
  IF v_s.end_date IS DISTINCT FROM p_end THEN
    INSERT INTO public.project_audit_logs (project_id, stage_id, changed_by, field, old_value, new_value)
    VALUES (v_p.id, p_stage, auth.uid(), 'stage.end_date', v_s.end_date::text, p_end::text);
  END IF;
  UPDATE public.project_stages
    SET start_date = p_start, end_date = p_end,
        -- re-open if the new end is in the future again
        tracking_state = CASE WHEN p_end IS NULL OR p_end >= CURRENT_DATE THEN 'active' ELSE tracking_state END,
        soft_closed_at = CASE WHEN p_end IS NULL OR p_end >= CURRENT_DATE THEN NULL ELSE soft_closed_at END
    WHERE id = p_stage;

  -- Setting a real end date on every stage clears the parent project's review flag.
  UPDATE public.projects pr SET needs_date_review = false
   WHERE pr.id = v_p.id AND pr.needs_date_review
     AND NOT EXISTS (
       SELECT 1 FROM public.project_stages st
        WHERE st.project_id = pr.id AND st.end_date IS NULL AND NOT st.is_archived
     );
END;
$$;
