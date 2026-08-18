-- =============================================================
-- Migration v17: Block future-dated timesheets
--
-- Employees may backdate freely (that is the whole point of the backlog
-- and the reminder job) but must not log work that hasn't happened yet.
-- Nothing enforced this before — not the client, not the XLSX importer,
-- not the database.
--
-- "Future" is judged against the EMPLOYEE'S OWN OFFICE local date, not
-- CURRENT_DATE (UTC) and not the browser's clock. Those three disagree
-- for several hours every day: at 02:00 on the 12th in Dubai it is still
-- the 11th in UTC, so a UTC check would wrongly reject a perfectly
-- ordinary same-day entry — and a browser-clock check is trivially
-- defeated by changing the system clock. offices.timezone (added in v13)
-- is what makes the correct comparison possible.
--
-- Enforced as a trigger rather than a CHECK constraint or an RLS policy:
--   * a CHECK cannot call now() (not IMMUTABLE) or look up another table;
--   * an RLS WITH CHECK would cover the client path but NOT the XLSX
--     importer, which writes through the service role and bypasses RLS
--     entirely. Triggers still fire for service_role, so this one rule
--     covers both write paths.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.block_future_timesheet()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE; v_zone TEXT;
BEGIN
  -- Only relevant when the date is actually being set or moved. A
  -- manager approving/rejecting an existing sheet leaves `date` alone and
  -- must not be blocked just because the sheet is old.
  IF TG_OP = 'UPDATE' AND NEW.date IS NOT DISTINCT FROM OLD.date THEN
    RETURN NEW;
  END IF;

  -- LEFT JOIN, not JOIN: profiles.office_id is nullable, and someone with
  -- no office assigned should still be held to *a* rule rather than
  -- silently skipping the check.
  SELECT o.timezone INTO v_zone
    FROM public.profiles p
    LEFT JOIN public.offices o ON o.id = p.office_id
   WHERE p.id = NEW.employee_id;

  -- UTC is the strictest sane fallback: it is never AHEAD of any office,
  -- so an employee with no office can never gain extra days from it.
  v_today := (now() AT TIME ZONE COALESCE(v_zone, 'UTC'))::date;

  IF NEW.date > v_today THEN
    RAISE EXCEPTION
      'Timesheets cannot be dated in the future — % is after today (%) in your office''s time zone.',
      to_char(NEW.date, 'DD Mon YYYY'), to_char(v_today, 'DD Mon YYYY');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS timesheets_block_future ON public.timesheets;
CREATE TRIGGER timesheets_block_future
  BEFORE INSERT OR UPDATE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.block_future_timesheet();

-- ── Verify before continuing ─────────────────────────────────────────
-- Surfaces pre-existing future-dated rows rather than failing on them:
-- the trigger only guards new writes, so anything already in the table
-- stays put and would otherwise be invisible.
DO $$
DECLARE v_future INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'timesheets_block_future' AND tgrelid = 'public.timesheets'::regclass
  ) THEN
    RAISE EXCEPTION 'v17 verification failed: timesheets_block_future trigger missing';
  END IF;

  SELECT COUNT(*) INTO v_future
  FROM public.timesheets t
  JOIN public.profiles p ON p.id = t.employee_id
  LEFT JOIN public.offices o ON o.id = p.office_id
  WHERE t.date > (now() AT TIME ZONE COALESCE(o.timezone, 'UTC'))::date;

  IF v_future > 0 THEN
    RAISE WARNING 'v17: % existing timesheet(s) are dated in the future. The trigger does not remove them — review with the query in this file''s footer.', v_future;
  END IF;
END $$;

COMMIT;

-- =============================================================
-- Pre-existing future-dated timesheets, if the warning above fired:
--
--   SELECT t.id, p.email, t.date, t.status, t.created_at, o.name AS office
--   FROM public.timesheets t
--   JOIN public.profiles p ON p.id = t.employee_id
--   LEFT JOIN public.offices o ON o.id = p.office_id
--   WHERE t.date > (now() AT TIME ZONE COALESCE(o.timezone, 'UTC'))::date
--   ORDER BY t.date DESC;
--
-- Left in place deliberately — they may be legitimate historical data
-- entered before this rule existed. Delete via the IT-gated
-- delete-timesheets endpoint if they are not.
-- =============================================================
