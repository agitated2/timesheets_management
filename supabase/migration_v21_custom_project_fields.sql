-- =============================================================
-- Migration v21: Custom project fields
--
-- Admin-defined dropdown fields (e.g. "Building") attached to projects
-- and/or individual phases. When an employee logs time against a phase,
-- any field assigned to it appears on the entry; values then roll up as
-- filters and groupings in Project Analytics.
--
-- See HANDOFF_PLAN.md Task F for the full rationale. The four decisions
-- baked into this schema:
--
--   * Definitions are WORKSPACE-level, not per-project. Per-project field
--     names would fragment into "Building"/"building"/"Bldg No." and
--     destroy the cross-project aggregation this exists for.
--
--   * Values store BOTH option_id and a label snapshot. The FK gives
--     clean joins and GROUP BY; the snapshot answers "what did this say
--     when it was submitted". With only the FK, renaming an option
--     silently rewrites history.
--
--   * Assignment is project-level with per-phase override (D-d).
--     stage_id NULL = every phase of the project; a row with stage_id set
--     overrides for that phase. 'disabled' is a real stored requirement
--     so one phase can opt out of an otherwise project-wide field.
--
--   * N/A is a real, undeletable sentinel OPTION, not the absence of a
--     value (D-e). "User said not applicable", "user left it blank" and
--     "field didn't exist yet" are three different facts; collapsing them
--     makes every report that touches this column a lie.
--
-- v1 is SELECT-only by design: free text cannot be aggregated, which is
-- the entire purpose. The values table is already a junction, so
-- multi-select later is just relaxing a uniqueness constraint.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

-- ── (a) The Library ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.custom_fields (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness: "Building" and "building" being separate
-- fields is precisely the fragmentation this design exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_fields_name_lower
  ON public.custom_fields (lower(name));

DROP TRIGGER IF EXISTS custom_fields_updated_at ON public.custom_fields;
CREATE TRIGGER custom_fields_updated_at BEFORE UPDATE ON public.custom_fields
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── (b) Options ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.custom_field_options (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id       UUID NOT NULL REFERENCES public.custom_fields(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  is_archived    BOOLEAN NOT NULL DEFAULT false,
  -- The auto-created "N/A" row. Exactly one per field, never deletable,
  -- always sorts first, and is the default selection on the entry form.
  is_na_sentinel BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_options_field_label_lower
  ON public.custom_field_options (field_id, lower(label));
CREATE INDEX IF NOT EXISTS idx_cf_options_field ON public.custom_field_options (field_id);
-- At most one sentinel per field.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_options_one_sentinel
  ON public.custom_field_options (field_id) WHERE is_na_sentinel;

-- Every field gets its N/A option automatically, so no code path can
-- create a field that lacks one.
CREATE OR REPLACE FUNCTION public.create_na_option()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.custom_field_options (field_id, label, sort_order, is_na_sentinel)
  VALUES (NEW.id, 'N/A', -1, true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_fields_add_na ON public.custom_fields;
CREATE TRIGGER custom_fields_add_na AFTER INSERT ON public.custom_fields
  FOR EACH ROW EXECUTE FUNCTION public.create_na_option();

-- The sentinel must survive: deleting it would leave entries pointing at
-- nothing and remove the only way to say "not applicable".
CREATE OR REPLACE FUNCTION public.protect_na_option()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_na_sentinel THEN
      RAISE EXCEPTION 'The N/A option is built in and cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;

  -- Renaming, archiving, or un-flagging the sentinel are all ways of
  -- losing it by another name.
  IF OLD.is_na_sentinel AND (
       NEW.is_na_sentinel IS DISTINCT FROM OLD.is_na_sentinel
    OR NEW.label          IS DISTINCT FROM OLD.label
    OR NEW.is_archived
  ) THEN
    RAISE EXCEPTION 'The N/A option is built in and cannot be renamed, archived, or reassigned.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cf_options_protect_na ON public.custom_field_options;
CREATE TRIGGER cf_options_protect_na BEFORE UPDATE OR DELETE ON public.custom_field_options
  FOR EACH ROW EXECUTE FUNCTION public.protect_na_option();

-- ── (c) Assignments ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE custom_field_requirement AS ENUM ('required', 'optional', 'disabled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS public.custom_field_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id    UUID NOT NULL REFERENCES public.custom_fields(id)   ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES public.projects(id)        ON DELETE CASCADE,
  -- NULL = applies to every phase of the project. A row with stage_id
  -- set overrides the project-level row for that phase.
  stage_id    UUID REFERENCES public.project_stages(id)           ON DELETE CASCADE,
  requirement custom_field_requirement NOT NULL DEFAULT 'optional',
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two partial indexes rather than one over (field, project, stage):
-- NULLs don't compare equal in a UNIQUE index, so a plain index would
-- happily allow several project-level rows for the same field.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_assign_project_level
  ON public.custom_field_assignments (field_id, project_id) WHERE stage_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_assign_stage_level
  ON public.custom_field_assignments (field_id, project_id, stage_id) WHERE stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cf_assign_project ON public.custom_field_assignments (project_id);
CREATE INDEX IF NOT EXISTS idx_cf_assign_stage   ON public.custom_field_assignments (stage_id);

-- ── (d) Values ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.timesheet_entry_field_values (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id             UUID NOT NULL REFERENCES public.timesheet_entries(id)  ON DELETE CASCADE,
  field_id             UUID NOT NULL REFERENCES public.custom_fields(id)      ON DELETE CASCADE,
  -- RESTRICT, not CASCADE or SET NULL: an option must never be hard
  -- deleted while values reference it. Archiving is the supported path
  -- (see protect/archive semantics above), and this makes that a rule
  -- rather than a convention.
  option_id            UUID NOT NULL REFERENCES public.custom_field_options(id) ON DELETE RESTRICT,
  -- What the option said at write time. Renaming an option must not
  -- rewrite history; this is the audit answer, option_id is the join key.
  option_label_snapshot TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One value per (entry, field) in v1. Dropping this constraint is all
-- that multi-select would require.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_field_values_unique
  ON public.timesheet_entry_field_values (entry_id, field_id);
CREATE INDEX IF NOT EXISTS idx_entry_field_values_entry  ON public.timesheet_entry_field_values (entry_id);
-- Backs the analytics filter/group-by path: "hours where field X = option Y".
CREATE INDEX IF NOT EXISTS idx_entry_field_values_field_option
  ON public.timesheet_entry_field_values (field_id, option_id);

-- Snapshot is filled server-side from the option, so a client cannot
-- write a label that disagrees with the option it points at.
CREATE OR REPLACE FUNCTION public.set_field_value_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_label TEXT; v_field UUID;
BEGIN
  SELECT label, field_id INTO v_label, v_field
  FROM public.custom_field_options WHERE id = NEW.option_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown custom field option.';
  END IF;
  -- The option must belong to the field being recorded, or the value is
  -- incoherent (e.g. a "Building" field holding a "Zone" option).
  IF v_field <> NEW.field_id THEN
    RAISE EXCEPTION 'That option does not belong to the selected field.';
  END IF;

  NEW.option_label_snapshot := v_label;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entry_field_values_snapshot ON public.timesheet_entry_field_values;
CREATE TRIGGER entry_field_values_snapshot
  BEFORE INSERT OR UPDATE ON public.timesheet_entry_field_values
  FOR EACH ROW EXECUTE FUNCTION public.set_field_value_snapshot();

-- ── (e) Resolution helper ───────────────────────────────────────────
-- Which fields apply to a given stage, and how. Most specific wins:
-- a stage-level row beats the project-level row for that field.
-- 'disabled' rows are returned so the caller can tell "explicitly off"
-- from "never assigned" — the entry form filters them out, the
-- assignment UI needs to show them.
CREATE OR REPLACE FUNCTION public.fields_for_stage(p_stage UUID)
RETURNS TABLE (
  field_id    UUID,
  field_name  TEXT,
  requirement custom_field_requirement
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT ON (a.field_id)
         a.field_id, f.name, a.requirement
  FROM public.custom_field_assignments a
  JOIN public.custom_fields f ON f.id = a.field_id
  JOIN public.project_stages s ON s.id = p_stage
  WHERE a.project_id = s.project_id
    AND (a.stage_id = p_stage OR a.stage_id IS NULL)
    AND f.is_active
  -- stage-specific row (stage_id NOT NULL) sorts first, so DISTINCT ON
  -- keeps it over the project-level fallback.
  ORDER BY a.field_id, (a.stage_id IS NULL);
$$;

-- ── (f) RLS ─────────────────────────────────────────────────────────
ALTER TABLE public.custom_fields                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_field_options          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_field_assignments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_entry_field_values  ENABLE ROW LEVEL SECURITY;

-- Definitions: readable by everyone signed in (the entry form has to
-- render them), writable only by whoever already manages projects.
DROP POLICY IF EXISTS "cf_read"   ON public.custom_fields;
DROP POLICY IF EXISTS "cf_manage" ON public.custom_fields;
CREATE POLICY "cf_read"   ON public.custom_fields FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "cf_manage" ON public.custom_fields FOR ALL
  USING (public.can_manage_projects()) WITH CHECK (public.can_manage_projects());

DROP POLICY IF EXISTS "cf_opt_read"   ON public.custom_field_options;
DROP POLICY IF EXISTS "cf_opt_manage" ON public.custom_field_options;
CREATE POLICY "cf_opt_read"   ON public.custom_field_options FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "cf_opt_manage" ON public.custom_field_options FOR ALL
  USING (public.can_manage_projects()) WITH CHECK (public.can_manage_projects());

DROP POLICY IF EXISTS "cf_assign_read"   ON public.custom_field_assignments;
DROP POLICY IF EXISTS "cf_assign_manage" ON public.custom_field_assignments;
CREATE POLICY "cf_assign_read"   ON public.custom_field_assignments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "cf_assign_manage" ON public.custom_field_assignments FOR ALL
  USING (public.can_manage_projects()) WITH CHECK (public.can_manage_projects());

-- Values: visible EXACTLY where the parent entry is visible. Each policy
-- below mirrors one of the six on timesheet_entries — deliberately
-- restated rather than simplified, because a looser rule here would leak
-- per-entry operational detail to someone who cannot see the entry
-- itself.
DROP POLICY IF EXISTS "efv_read_own"              ON public.timesheet_entry_field_values;
DROP POLICY IF EXISTS "efv_read_manager"          ON public.timesheet_entry_field_values;
DROP POLICY IF EXISTS "efv_read_privileged"       ON public.timesheet_entry_field_values;
DROP POLICY IF EXISTS "efv_read_global_analytics" ON public.timesheet_entry_field_values;
DROP POLICY IF EXISTS "efv_read_team_analytics"   ON public.timesheet_entry_field_values;
DROP POLICY IF EXISTS "efv_read_hr_view"          ON public.timesheet_entry_field_values;
DROP POLICY IF EXISTS "efv_insert_own"            ON public.timesheet_entry_field_values;

CREATE POLICY "efv_read_own" ON public.timesheet_entry_field_values
  FOR SELECT USING (
    entry_id IN (
      SELECT e.id FROM public.timesheet_entries e
      JOIN public.timesheets t ON t.id = e.timesheet_id
      WHERE t.employee_id = auth.uid()
    )
  );

CREATE POLICY "efv_read_manager" ON public.timesheet_entry_field_values
  FOR SELECT USING (
    (public.my_has_role('manager') OR public.my_has_role('c_suite'))
    AND entry_id IN (
      SELECT e.id FROM public.timesheet_entries e
      JOIN public.timesheets t ON t.id = e.timesheet_id
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.i_manage(t.employee_id) AND public.can_see_office(pr.office_id)
    )
  );

CREATE POLICY "efv_read_privileged" ON public.timesheet_entry_field_values
  FOR SELECT USING (
    (public.my_has_role('hr') OR public.my_has_role('c_suite') OR public.my_has_role('it'))
    AND entry_id IN (
      SELECT e.id FROM public.timesheet_entries e
      JOIN public.timesheets t ON t.id = e.timesheet_id
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

CREATE POLICY "efv_read_global_analytics" ON public.timesheet_entry_field_values
  FOR SELECT USING (
    public.my_has_role('global_analytics')
    AND entry_id IN (
      SELECT e.id FROM public.timesheet_entries e
      JOIN public.timesheets t ON t.id = e.timesheet_id
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

CREATE POLICY "efv_read_team_analytics" ON public.timesheet_entry_field_values
  FOR SELECT USING (
    public.my_has_role('team_analytics')
    AND entry_id IN (
      SELECT e.id FROM public.timesheet_entries e
      JOIN public.timesheets t ON t.id = e.timesheet_id
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.i_manage(t.employee_id) AND public.can_see_office(pr.office_id)
    )
  );

CREATE POLICY "efv_read_hr_view" ON public.timesheet_entry_field_values
  FOR SELECT USING (
    public.my_has_role('hr_view_timesheets')
    AND entry_id IN (
      SELECT e.id FROM public.timesheet_entries e
      JOIN public.timesheets t ON t.id = e.timesheet_id
      JOIN public.profiles pr ON pr.id = t.employee_id
      WHERE public.can_see_office(pr.office_id)
    )
  );

-- Writable only by the entry's owner, and only while the parent timesheet
-- is still pending — mirroring entries_insert_own as fixed in v15, so
-- values can't be appended to an already-approved sheet.
CREATE POLICY "efv_insert_own" ON public.timesheet_entry_field_values
  FOR INSERT WITH CHECK (
    entry_id IN (
      SELECT e.id FROM public.timesheet_entries e
      JOIN public.timesheets t ON t.id = e.timesheet_id
      WHERE t.employee_id = auth.uid() AND t.status = 'pending'
    )
  );

-- ── (g) Usage count, for the archive-with-warning flow ──────────────
-- D-c: archiving an in-use option warns with a count, then proceeds.
-- SECURITY DEFINER because a projects_control user legitimately needs the
-- count across every employee's entries, which RLS would otherwise trim
-- to only the ones they can see — a misleadingly low number is worse than
-- no number. Returns a bare integer, no per-entry detail.
CREATE OR REPLACE FUNCTION public.custom_field_option_usage(p_option UUID)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*)::INT FROM public.timesheet_entry_field_values WHERE option_id = p_option;
$$;

REVOKE EXECUTE ON FUNCTION public.custom_field_option_usage(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.custom_field_option_usage(UUID) TO authenticated;

-- ── Verify before continuing ─────────────────────────────────────────
DO $$
DECLARE v_missing TEXT := '';
BEGIN
  IF to_regclass('public.custom_fields')                IS NULL THEN v_missing := v_missing || ' custom_fields'; END IF;
  IF to_regclass('public.custom_field_options')         IS NULL THEN v_missing := v_missing || ' custom_field_options'; END IF;
  IF to_regclass('public.custom_field_assignments')     IS NULL THEN v_missing := v_missing || ' custom_field_assignments'; END IF;
  IF to_regclass('public.timesheet_entry_field_values') IS NULL THEN v_missing := v_missing || ' timesheet_entry_field_values'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'custom_fields_add_na'
      AND tgrelid = 'public.custom_fields'::regclass
  ) THEN v_missing := v_missing || ' custom_fields_add_na'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'entry_field_values_snapshot'
      AND tgrelid = 'public.timesheet_entry_field_values'::regclass
  ) THEN v_missing := v_missing || ' entry_field_values_snapshot'; END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'v21 verification failed, missing:%', v_missing;
  END IF;

  -- Any field lacking its N/A sentinel would break the entry form's
  -- default selection.
  IF EXISTS (
    SELECT 1 FROM public.custom_fields f
    WHERE NOT EXISTS (
      SELECT 1 FROM public.custom_field_options o
      WHERE o.field_id = f.id AND o.is_na_sentinel
    )
  ) THEN
    RAISE EXCEPTION 'v21 verification failed: one or more custom_fields has no N/A sentinel option';
  END IF;
END $$;

COMMIT;
