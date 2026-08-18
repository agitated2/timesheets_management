-- =============================================================
-- Migration v5: Disciplines (managed list + per-entry discipline)
--
-- Replaces the free-text profiles.discipline with a managed
-- `disciplines` table, adds a per-timesheet-entry discipline, and
-- the governance around it:
--   • Employees pick their discipline ONCE at onboarding; thereafter
--     only the Policies role (hr_manage_policies) or IT may change it.
--   • Every timesheet entry must carry a discipline (defaults to the
--     employee's home discipline but may differ, for cross-discipline
--     cost analytics).
--
-- Idempotent — safe to re-run.
-- =============================================================

-- ── Table ────────────────────────────────────────────────────
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

-- ── Columns: replace free-text discipline with FK; add per-entry discipline ──
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS discipline_id UUID REFERENCES public.disciplines(id) ON DELETE SET NULL;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS discipline;

ALTER TABLE public.timesheet_entries
  ADD COLUMN IF NOT EXISTS discipline_id UUID REFERENCES public.disciplines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_timesheet_entries_discipline ON public.timesheet_entries(discipline_id);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.disciplines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "disciplines_read"   ON public.disciplines;
DROP POLICY IF EXISTS "disciplines_manage" ON public.disciplines;
-- Everyone signed in can read (onboarding + per-entry dropdowns need the list)
CREATE POLICY "disciplines_read" ON public.disciplines
  FOR SELECT USING (auth.uid() IS NOT NULL);
-- Manage = Policies role or IT
CREATE POLICY "disciplines_manage" ON public.disciplines
  FOR ALL USING (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'))
  WITH CHECK (public.my_has_role('hr_manage_policies') OR public.my_has_role('it'));

-- ── Governance: set-once for employees; HR/IT may change anytime ──
CREATE OR REPLACE FUNCTION public.guard_discipline_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.discipline_id IS DISTINCT FROM OLD.discipline_id THEN
    IF public.my_has_role('hr_manage_policies') OR public.my_has_role('it') THEN
      RETURN NEW;  -- Policies/IT may change anytime
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

-- ── Every entry must carry a discipline (write-time backstop) ──
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

-- ── RPCs ─────────────────────────────────────────────────────
-- Create or update a discipline (name / active). p_id NULL = create.
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

-- Assign a home discipline to one or more employees.
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
