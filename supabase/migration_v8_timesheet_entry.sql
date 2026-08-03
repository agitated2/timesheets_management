-- =============================================================
-- Migration v8: Timesheet entry revamp
--
-- (a) App-level feature flags (singleton row). Currently just the XLSX
--     upload toggle — in-app entry is the default, XLSX is opt-in per
--     deployment, controlled from IT Panel → Settings.
-- (b) One timesheet per employee per day. An employee may hold at most
--     one pending-or-approved timesheet per date; resubmission is only
--     possible once a manager rejects the previous one. Enforced by a
--     partial unique index — existing duplicates are superseded
--     (marked rejected) first so the index can be created.
--
-- Idempotent — safe to re-run.
-- =============================================================

-- ── (a) App settings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  xlsx_upload_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          UUID REFERENCES public.profiles(id)
);
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "settings_read"   ON public.app_settings;
DROP POLICY IF EXISTS "settings_manage" ON public.app_settings;
-- Every signed-in user can read it (the upload page needs to know which
-- mode to show); only IT can change it.
CREATE POLICY "settings_read" ON public.app_settings
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "settings_manage" ON public.app_settings
  FOR ALL USING (public.my_has_role('it')) WITH CHECK (public.my_has_role('it'));

-- ── (b) One timesheet per employee per day ────────────────────
-- Dedupe FIRST or the index creation fails. Non-destructive: the older of
-- any (employee, date) duplicates is superseded (marked rejected with a
-- reason) rather than deleted, so the historical record is preserved and
-- the employee can see why it needs resubmitting if it wasn't reviewed yet.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY employee_id, date ORDER BY created_at DESC) AS rn
  FROM public.timesheets
  WHERE status IN ('pending', 'approved')
)
UPDATE public.timesheets t
   SET status = 'rejected',
       rejection_reason = COALESCE(t.rejection_reason,
                          'Superseded — duplicate submission for this date.')
  FROM ranked r
 WHERE t.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_timesheets_one_per_day
  ON public.timesheets (employee_id, date)
  WHERE status IN ('pending', 'approved');
