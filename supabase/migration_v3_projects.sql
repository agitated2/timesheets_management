-- =============================================================
-- Migration v3: Projects Management System
-- Run in TWO separate executions in the Supabase SQL Editor.
-- =============================================================

-- =============================================================
-- PART 1 OF 2 — Run this first, wait for success, then run Part 2.
-- =============================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'projects_control';

-- =============================================================
-- PART 2 OF 2 — Run ONLY after Part 1 has succeeded.
-- =============================================================

-- Project status enum
DO $$ BEGIN
  CREATE TYPE project_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Tables ──────────────────────────────────────────────────────────

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
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id     UUID NOT NULL REFERENCES public.project_stages(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  changed_by   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  change_type  TEXT NOT NULL,
  old_start    DATE,
  new_start    DATE,
  old_end      DATE,
  new_end      DATE,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_project_stages_project  ON public.project_stages(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_employee ON public.project_members(employee_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_project      ON public.project_stage_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_stage        ON public.project_stage_logs(stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_created      ON public.project_stage_logs(created_at DESC);

-- ── Triggers ─────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS projects_updated_at       ON public.projects;
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS project_stages_updated_at ON public.project_stages;
CREATE TRIGGER project_stages_updated_at BEFORE UPDATE ON public.project_stages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────

ALTER TABLE public.projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_stages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_stage_logs ENABLE ROW LEVEL SECURITY;

-- projects: projects_control/IT manage; employees read projects they're assigned to
DROP POLICY IF EXISTS "projects_manage"      ON public.projects;
DROP POLICY IF EXISTS "projects_read_member" ON public.projects;
CREATE POLICY "projects_manage" ON public.projects
  FOR ALL USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "projects_read_member" ON public.projects
  FOR SELECT USING (
    id IN (SELECT project_id FROM public.project_members WHERE employee_id = auth.uid())
  );

-- project_stages: same access pattern
DROP POLICY IF EXISTS "stages_manage"      ON public.project_stages;
DROP POLICY IF EXISTS "stages_read_member" ON public.project_stages;
CREATE POLICY "stages_manage" ON public.project_stages
  FOR ALL USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "stages_read_member" ON public.project_stages
  FOR SELECT USING (
    project_id IN (SELECT project_id FROM public.project_members WHERE employee_id = auth.uid())
  );

-- project_members
DROP POLICY IF EXISTS "members_manage"   ON public.project_members;
DROP POLICY IF EXISTS "members_read_own" ON public.project_members;
CREATE POLICY "members_manage" ON public.project_members
  FOR ALL USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "members_read_own" ON public.project_members
  FOR SELECT USING (employee_id = auth.uid());

-- project_stage_logs: no delete (audit integrity); read for control/IT
DROP POLICY IF EXISTS "stage_logs_read"   ON public.project_stage_logs;
DROP POLICY IF EXISTS "stage_logs_insert" ON public.project_stage_logs;
CREATE POLICY "stage_logs_read" ON public.project_stage_logs
  FOR SELECT USING (public.my_has_role('projects_control') OR public.my_has_role('it'));
CREATE POLICY "stage_logs_insert" ON public.project_stage_logs
  FOR INSERT WITH CHECK (public.my_has_role('projects_control') OR public.my_has_role('it'));

-- Done. Verify:
-- SELECT id, name, status FROM public.projects;
-- SELECT * FROM public.project_stage_logs ORDER BY created_at DESC LIMIT 10;
