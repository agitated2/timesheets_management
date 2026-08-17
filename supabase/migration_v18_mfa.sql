-- =============================================================
-- Migration v18: MFA grace period tracking
--
-- Backs the TOTP rollout in AUTH_HARDENING_PLAN.md Phase 2. Supabase's
-- own MFA state (auth.mfa_factors, aal) already tells the app whether a
-- user HAS a verified factor — what it has no concept of is a rolling
-- grace period before enrolment becomes mandatory, so that lives here.
--
-- mfa_grace_started_at is set ONCE, client-side, the first time a user
-- without a factor hits the post-login gate (covers both brand-new users
-- and everyone existing at rollout — D5 in the plan: same 7-day grace for
-- both, starting whenever they first show up after this ships). From then
-- on it must never move: a renewable grace period is not a grace period.
--
-- Enforced in guard_profile_privileged_columns() (v15) rather than a new
-- trigger — one place already owns "which profile columns can a non-IT
-- user write, and under what condition".
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS mfa_grace_started_at TIMESTAMPTZ;

-- CREATE OR REPLACE on the same function name — the existing
-- profiles_guard_privileged trigger (v15) picks this up automatically,
-- no DROP/CREATE TRIGGER needed.
CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR public.my_has_role('it') THEN
    RETURN NEW;
  END IF;

  IF NEW.roles                 IS DISTINCT FROM OLD.roles
  OR NEW.role                  IS DISTINCT FROM OLD.role
  OR NEW.sees_all_offices      IS DISTINCT FROM OLD.sees_all_offices
  OR NEW.office_id             IS DISTINCT FROM OLD.office_id
  OR NEW.additional_office_ids IS DISTINCT FROM OLD.additional_office_ids
  OR NEW.joining_date          IS DISTINCT FROM OLD.joining_date
  OR NEW.email                 IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'Roles, offices, joining date and email can only be changed by IT.';
  END IF;

  IF (NEW.manager_ids IS DISTINCT FROM OLD.manager_ids
      OR NEW.manager_id IS DISTINCT FROM OLD.manager_id)
     AND OLD.onboarding_complete THEN
    RAISE EXCEPTION 'Your line manager can only be changed by IT.';
  END IF;

  IF OLD.onboarding_complete AND NOT NEW.onboarding_complete THEN
    RAISE EXCEPTION 'Onboarding cannot be reset.';
  END IF;

  -- Settable once (NULL -> a timestamp) by the user themselves — that's
  -- the MfaGate starting their own grace period. Once set, only IT may
  -- change it (the early-return above already covers IT, including
  -- resetting it back to NULL when removing a lost-device factor).
  IF NEW.mfa_grace_started_at IS DISTINCT FROM OLD.mfa_grace_started_at
     AND OLD.mfa_grace_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'The MFA grace period cannot be modified once started.';
  END IF;

  RETURN NEW;
END;
$$;

-- ── Verify before continuing ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'mfa_grace_started_at'
  ) THEN
    RAISE EXCEPTION 'v18 verification failed: mfa_grace_started_at column missing';
  END IF;
END $$;

COMMIT;
