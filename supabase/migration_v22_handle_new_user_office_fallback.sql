-- =============================================================
-- Migration v22: handle_new_user() must never produce a NULL office
--
-- profiles.office_id is NOT NULL, but handle_new_user() could still hand
-- it a NULL:
--
--   * the account was created without office metadata — most notably
--     Supabase Dashboard -> Authentication -> Add user, which sends none;
--   * or the metadata named an unknown/deactivated office, which v15
--     deliberately discards to NULL.
--
-- Either way the INSERT violates NOT NULL, the trigger raises, and the
-- ENTIRE auth.users INSERT is rolled back — the account is never created,
-- and the caller sees a not-null-violation from a trigger they never
-- invoked. On a fresh database this breaks the very first bootstrap step,
-- because there is no IT user yet and therefore no way to use the normal
-- create-user path.
--
-- Fix: fall back to an active office. This is NOT a way for a client to
-- choose an office — the metadata branch already rejects anything invalid,
-- and the fallback ignores client input entirely. create-user and
-- bulk-import-users always pass an explicit office, so in practice this
-- only fires for manually-created accounts, which IT then assigns
-- properly afterwards via Admin -> Edit user.
--
-- If no office exists at all, raise a clear, actionable error instead of
-- a bare constraint violation.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_office UUID;
BEGIN
  v_office := NULLIF(NEW.raw_user_meta_data->>'office_id', '')::UUID;

  IF v_office IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.offices WHERE id = v_office AND is_active) THEN
    v_office := NULL;
  END IF;

  IF v_office IS NULL THEN
    SELECT id INTO v_office FROM public.offices
     WHERE is_active ORDER BY created_at, name LIMIT 1;
  END IF;

  IF v_office IS NULL THEN
    RAISE EXCEPTION 'Cannot create a user before any active office exists. Create an office first (see DEPLOYMENT.md A6).';
  END IF;

  INSERT INTO public.profiles (id, email, office_id)
  VALUES (NEW.id, NEW.email, v_office)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ── Verify before continuing ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'on_auth_user_created' AND tgrelid = 'auth.users'::regclass
  ) THEN
    RAISE EXCEPTION 'v22 verification failed: on_auth_user_created trigger missing';
  END IF;

  -- Not fatal, but worth surfacing: with no active office, user creation
  -- will now fail with a clear message rather than a constraint error.
  IF NOT EXISTS (SELECT 1 FROM public.offices WHERE is_active) THEN
    RAISE WARNING 'v22: no active office exists — user creation will be refused until one is created.';
  END IF;
END $$;

COMMIT;
