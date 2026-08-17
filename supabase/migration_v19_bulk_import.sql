-- =============================================================
-- Migration v19: Bulk employee import support
--
-- Backs Phase 3 of AUTH_HARDENING_PLAN.md — the bulk-import-users Edge
-- Function creates accounts with a system-generated temporary password
-- (never chosen by IT, never emailed) and must_change_password marks
-- those accounts so the temp password cannot silently become permanent.
--
-- Deliberately NOT added to the v15 guard_profile_privileged_columns
-- allow-list: this column is not privilege-sensitive the way roles/
-- office_id/manager_ids are. A user can only ever clear their OWN flag
-- (via profiles_update_own, same policy that already lets them set
-- full_name), and clearing it just means "I finished the forced change" —
-- there is no attack in a user marking their own password as changed.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- ── Verify before continuing ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'must_change_password'
  ) THEN
    RAISE EXCEPTION 'v19 verification failed: must_change_password column missing';
  END IF;
END $$;

COMMIT;
