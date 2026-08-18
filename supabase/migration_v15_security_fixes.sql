-- =============================================================
-- Migration v15: Security fixes
--
-- Closes four remotely-exploitable holes found in a full audit of the
-- RLS policies, SECURITY DEFINER functions and service-role endpoints.
-- Every one of these was reachable by an ordinary logged-in employee
-- with nothing but the browser console — no special tooling needed.
--
--   (a) CRITICAL — profiles_update_own granted row-level UPDATE on your
--       own profile with NO column restriction, and the only BEFORE
--       UPDATE trigger on profiles guarded discipline_id alone. Any user
--       could therefore run
--         supabase.from('profiles').update({ roles: ['it'] }).eq('id', <self>)
--       and become IT admin — which bypasses every my_has_role('it')
--       gate in the schema, every admin RPC, and the Netlify
--       user-management endpoints. Fixed with a trigger that rejects
--       self-writes to the privileged columns.
--
--   (b) CRITICAL — timesheets_insert_own checked only that employee_id
--       was you, never that status was 'pending'. `status` merely
--       DEFAULTs to 'pending'; nothing stopped a client sending
--       status='approved' with a forged reviewer_id, fabricating an
--       approved timesheet and skipping manager review entirely.
--
--   (c) HIGH — entries_insert_own checked only that the parent timesheet
--       was yours, never its status, and none of the three BEFORE INSERT
--       triggers on timesheet_entries validate approval state. An
--       employee could submit a minimal sheet, get it approved, then
--       keep appending hours to the approved row after the fact.
--
--   (d) MEDIUM — notify_hr_approvers(TEXT) is SECURITY DEFINER with no
--       internal authorization check and no REVOKE, so any authenticated
--       user could call it via PostgREST RPC and push arbitrary
--       attacker-controlled text as a notification to every HR approver
--       and IT user. It is only ever called internally from
--       decide_leave_request / submit_leave_request.
--
--   (e) MEDIUM — handle_new_user() reads office_id straight from
--       client-supplied signup metadata without validating it. Hardened
--       to accept only a real, ACTIVE office. NOTE: this does not stop a
--       self-registering user CHOOSING their office — that is only
--       controlled by whether signups are open at all. See the manual
--       step at the bottom of this file.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

-- ── (a) Lock down privileged profile columns ───────────────────────
-- RLS is row-level, not column-level: profiles_update_own says "you may
-- update your own row" and says nothing about WHICH columns, so it has
-- to be a trigger rather than a policy rewrite.
--
-- The two exemptions at the top are both load-bearing:
--   * auth.uid() IS NULL  — the service-role path. Triggers still fire
--     for service_role (only RLS is bypassed), and a service_role JWT
--     carries no `sub` claim, so auth.uid() is NULL. Without this,
--     netlify/functions/create-user.js and update-user.js would start
--     failing when they set roles/email/manager_ids. This is NOT an
--     anon hole: an anon caller satisfies neither profiles_update_own
--     (auth.uid() = id is NULL = id → false) nor profiles_update_it, so
--     RLS rejects the row before this trigger is ever consulted.
--   * my_has_role('it')   — preserves IT's own in-app role management
--     (AdminPage's edit-user modal, SettingsPage's role matrix), which
--     goes through the user's session rather than the service key.
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

  -- manager_ids/manager_id are set once during onboarding (the employee
  -- picks their own line manager on OnboardingPage) and are immutable
  -- afterwards — otherwise anyone could reassign themselves under a
  -- friendlier approver at will.
  IF (NEW.manager_ids IS DISTINCT FROM OLD.manager_ids
      OR NEW.manager_id IS DISTINCT FROM OLD.manager_id)
     AND OLD.onboarding_complete THEN
    RAISE EXCEPTION 'Your line manager can only be changed by IT.';
  END IF;

  -- Closes the loop on the rule above: without this, un-setting
  -- onboarding_complete would re-open the manager_ids window.
  IF OLD.onboarding_complete AND NOT NEW.onboarding_complete THEN
    RAISE EXCEPTION 'Onboarding cannot be reset.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_privileged ON public.profiles;
CREATE TRIGGER profiles_guard_privileged BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_columns();

-- ── (b) A self-submitted timesheet must start as pending ───────────
-- reviewer_id / rejection_reason are pinned to NULL too: both are
-- review-side fields, and a forged reviewer_id would make a fabricated
-- approval look legitimately signed off in the UI.
DROP POLICY IF EXISTS "timesheets_insert_own" ON public.timesheets;
CREATE POLICY "timesheets_insert_own" ON public.timesheets
  FOR INSERT WITH CHECK (
    auth.uid() = employee_id
    AND status = 'pending'
    AND reviewer_id IS NULL
    AND rejection_reason IS NULL
  );

-- ── (c) Entries may only be added to a PENDING timesheet ───────────
-- Rejected sheets are resubmitted as a brand-new row (see
-- idx_timesheets_one_per_day, which only counts pending/approved), so
-- restricting to 'pending' does not break resubmission.
DROP POLICY IF EXISTS "entries_insert_own" ON public.timesheet_entries;
CREATE POLICY "entries_insert_own" ON public.timesheet_entries
  FOR INSERT WITH CHECK (
    timesheet_id IN (
      SELECT id FROM public.timesheets
      WHERE employee_id = auth.uid() AND status = 'pending'
    )
  );

-- ── (d) notify_hr_approvers is internal-only ───────────────────────
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default. Its two callers
-- (decide_leave_request, submit_leave_request) are themselves SECURITY
-- DEFINER, so they keep working — the function executes as its owner
-- there, not as the caller.
REVOKE EXECUTE ON FUNCTION public.notify_hr_approvers(TEXT) FROM PUBLIC;

-- ── (e) Validate the signup office instead of trusting metadata ────
-- netlify/functions/create-user.js deliberately routes office_id through
-- user_metadata so the profile row is created WITH an office atomically,
-- so the metadata read has to stay. What changes is that a bogus,
-- unknown or deactivated office id now lands as NULL rather than being
-- written through verbatim.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_office UUID;
BEGIN
  v_office := NULLIF(NEW.raw_user_meta_data->>'office_id', '')::UUID;

  IF v_office IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.offices WHERE id = v_office AND is_active) THEN
    v_office := NULL;
  END IF;

  INSERT INTO public.profiles (id, email, office_id)
  VALUES (NEW.id, NEW.email, v_office)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ── Verify before continuing ─────────────────────────────────────────
DO $$
DECLARE v_missing TEXT := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_guard_privileged'
      AND tgrelid = 'public.profiles'::regclass
  ) THEN v_missing := v_missing || ' profiles_guard_privileged'; END IF;

  -- Read the ACL directly rather than via has_function_privilege(): there
  -- is no actual role named "public" to pass it. A NULL proacl means
  -- "defaults apply", and the default for a function INCLUDES EXECUTE to
  -- PUBLIC — so NULL is a failure here, not a pass. An explicit PUBLIC
  -- grant appears as an aclitem with an empty grantee, i.e. '=X/owner'.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    LEFT JOIN LATERAL unnest(p.proacl) AS a(acl) ON true
    WHERE p.oid = 'public.notify_hr_approvers(TEXT)'::regprocedure
      AND (p.proacl IS NULL OR a.acl::text LIKE '=%')
  ) THEN
    v_missing := v_missing || ' notify_hr_approvers-still-public';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'v15 verification failed:%', v_missing;
  END IF;
END $$;

COMMIT;

-- =============================================================
-- MANUAL STEP — not expressible in SQL
--
-- Finding (e) above is only half-fixable in the database. A
-- self-registering user still CHOOSES their own office, because the
-- trigger cannot distinguish an admin-created user from a self-signup
-- (both are inserted into auth.users by GoTrue itself, with no calling
-- JWT to inspect).
--
-- The actual control is whether self-signup is possible at all:
--   Dashboard -> Authentication -> Providers -> Email -> disable
--   "Enable sign-ups", so accounts can only be created by IT through
--   netlify/functions/create-user.js (which is IT-gated).
--
-- Verify no existing profile picked up a bogus office before this fix:
--   SELECT p.id, p.email, p.office_id FROM public.profiles p
--   LEFT JOIN public.offices o ON o.id = p.office_id
--   WHERE p.office_id IS NOT NULL AND (o.id IS NULL OR NOT o.is_active);
-- =============================================================
