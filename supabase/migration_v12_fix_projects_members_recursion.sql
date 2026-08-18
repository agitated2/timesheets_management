-- =============================================================
-- Migration v12: Fix infinite-recursion RLS bug on projects
--
-- migration_v10_offices.sql added "members_read_privileged" on
-- project_members, which reads public.projects directly inside its
-- USING clause to office-scope the check. projects' own
-- "projects_read_member" policy reads project_members right back
-- (membership grants project visibility). Both subqueries run under
-- RLS as the calling role, so each re-triggers the other table's
-- policies, and Postgres detects the cycle and raises 42P17
-- "infinite recursion detected in policy for relation projects" on
-- ANY select from projects, for every role.
--
-- This has been silent in the app: ProjectsPage.jsx's loadProjects()
-- destructures only `{ data: projs }` and never checks `error`, so
-- the failed query just renders an empty list. Newly created projects
-- are unaffected in the database (confirmed directly) — only the
-- listing query breaks.
--
-- Fix: resolve project_members' office check through a new
-- SECURITY DEFINER helper instead of a direct table reference in the
-- policy body. A SECURITY DEFINER function's body runs as its owner,
-- which bypasses RLS on the underlying table — the same mechanism
-- can_see_office() / my_has_role() already rely on to read profiles
-- without recursing — so the lookup no longer re-enters projects'
-- policies.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

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

COMMIT;
