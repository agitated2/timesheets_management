-- =============================================================
-- Migration v7: Projects — date-based tracking only
--
-- Hour-pool tracking is retired. Every project becomes date-tracked.
-- Existing hour-tracked projects are converted with start_date derived
-- from their earliest logged work and end_date left NULL (unbounded —
-- nobody is locked out of logging as a result of this migration).
-- They are flagged needs_date_review so a PM can set a real end date.
--
-- Columns (tracking_type, total_hours, allocated_hours) are RETAINED,
-- just unused going forward — cheap to keep, and makes reverting possible.
--
-- Idempotent — safe to re-run.
-- =============================================================

-- ── Retire the tracking-type lock ─────────────────────────────
-- A pre-existing trigger blocked ANY update that changes tracking_type
-- (added back when projects could be either 'hours' or 'date', to stop a
-- direct table edit from switching an existing project's type). It must be
-- dropped BEFORE the backfill below, which converts every 'hours' project
-- to 'date' — otherwise that UPDATE fails with:
--   "A project's tracking type cannot be changed after creation."
-- The trigger is now redundant, not just inconvenient: create_project()
-- already forces every new project to 'date', so nothing will ever need to
-- change tracking_type again.
DROP TRIGGER IF EXISTS projects_lock_tracking_type ON public.projects;
DROP FUNCTION IF EXISTS public.lock_project_tracking_type();

-- ── Flag + backfill ──────────────────────────────────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS needs_date_review BOOLEAN NOT NULL DEFAULT false;

UPDATE public.projects p SET
  tracking_type     = 'date',
  needs_date_review = true,
  start_date = COALESCE(
    p.start_date,
    (SELECT MIN(t.date) FROM public.timesheet_entries e
       JOIN public.timesheets t ON t.id = e.timesheet_id
      WHERE e.project_id = p.id),
    p.created_at::date
  ),
  end_date = NULL
WHERE p.tracking_type = 'hours';

UPDATE public.project_stages s SET
  start_date = COALESCE(s.start_date,
                        (SELECT start_date FROM public.projects WHERE id = s.project_id)),
  end_date   = NULL
WHERE s.start_date IS NULL;

-- ── RPCs: drop the hour-tracked branch from every project/stage RPC ──

CREATE OR REPLACE FUNCTION public.create_project(
  p_name TEXT, p_description TEXT, p_tracking_type project_tracking_type,
  p_start DATE, p_end DATE, p_total_hours NUMERIC
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.can_manage_projects() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_tracking_type IS DISTINCT FROM 'date' THEN
    RAISE EXCEPTION 'Hour-tracked projects are no longer supported — use date tracking.';
  END IF;
  IF p_start IS NULL THEN RAISE EXCEPTION 'A start date is required for a date-tracked project.'; END IF;
  IF p_end IS NOT NULL AND p_end < p_start THEN RAISE EXCEPTION 'End date cannot be before start date.'; END IF;

  INSERT INTO public.projects (name, description, tracking_type, start_date, end_date, total_hours, created_by)
  VALUES (p_name, NULLIF(trim(p_description), ''), 'date', p_start, p_end, NULL, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

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

  -- Setting a real end date on any stage clears the parent project's review flag
  -- once every stage has one — the common "PM finishes reviewing dates" path.
  UPDATE public.projects pr SET needs_date_review = false
   WHERE pr.id = v_p.id AND pr.needs_date_review
     AND NOT EXISTS (
       SELECT 1 FROM public.project_stages st
        WHERE st.project_id = pr.id AND st.end_date IS NULL AND NOT st.is_archived
     );
END;
$$;

-- ── View: drop the pool_full arm; every stage is now date-tracked ──
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

-- ── Write-time enforcement: drop the hour-pool branch ──
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

-- ── Hour-pool exhaustion trigger no longer applies ──
DROP TRIGGER IF EXISTS entries_after_hours_close ON public.timesheet_entries;
DROP FUNCTION IF EXISTS public.after_entry_hours_close();
