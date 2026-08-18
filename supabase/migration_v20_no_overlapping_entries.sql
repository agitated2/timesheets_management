-- =============================================================
-- Migration v20: No overlapping timesheet entries
--
-- Within one employee's one day, no two entries may cover overlapping
-- clock time. Two rules, both enforced here:
--
--   (a) time_to must be strictly AFTER time_from. Overnight shifts are
--       entered as two entries across two days, NOT as a single wrapped
--       22:00-02:00 range. See HANDOFF_PLAN.md decision D-a: hours then
--       land on the day they were actually worked, and the overlap test
--       below stays a simple interval comparison rather than needing to
--       segment wrapped ranges.
--
--       NOTE: calcHours() in src/pages/UploadPage.jsx and parseTimeRange()
--       in supabase/functions/parse-timesheet/index.ts previously WRAPPED
--       (`if (h < 0) h += 24`). Both are changed in the same commit as
--       this migration — otherwise the client happily computes hours for
--       an entry the database then rejects.
--
--   (b) No two entries on the same timesheet may overlap. Adjacency is
--       fine: 09:00-10:00 and 10:00-11:00 do not overlap. The half-open
--       test (`a.from < b.to AND a.to > b.from`) gets this right; do not
--       "fix" it to <=.
--
-- WHY A DEFERRED CONSTRAINT TRIGGER, not BEFORE INSERT FOR EACH ROW:
-- both write paths insert an entire day's entries in ONE statement
-- (`.insert(entries)` in UploadPage.jsx, and the same in parse-timesheet).
-- A BEFORE row trigger's SELECT runs against the command's snapshot, so
-- rows being inserted by the same command are not dependably visible to
-- one another — a naive BEFORE trigger would happily pass a batch that
-- overlaps ITSELF, which is exactly the case this migration exists to
-- prevent. A DEFERRABLE INITIALLY DEFERRED constraint trigger fires at
-- COMMIT, by which point every row in the batch is visible.
--
-- Idempotent — safe to re-run.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.block_overlapping_entries()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date DATE;
  v_other RECORD;
BEGIN
  -- Entries with no clock times at all are legitimate: parse-timesheet's
  -- section/legacy formats can produce them (see parseSectionEntries,
  -- which sets time_from/time_to to null when a row has no parseable
  -- range). Nothing to compare, so nothing to enforce — same early-out
  -- as block_entry_on_hourly_leave.
  IF NEW.time_from IS NULL OR NEW.time_to IS NULL THEN
    RETURN NULL;
  END IF;

  -- (a) Reject inverted / zero-length ranges.
  IF NEW.time_to <= NEW.time_from THEN
    RAISE EXCEPTION
      'A timesheet entry must end after it starts (got % to %). An overnight shift should be entered as two entries, one on each day.',
      to_char(NEW.time_from, 'HH24:MI'), to_char(NEW.time_to, 'HH24:MI');
  END IF;

  -- (b) Overlap against every OTHER entry on the same timesheet.
  -- Scoped by timesheet_id rather than (employee_id, date) because the
  -- partial unique index idx_timesheets_one_per_day already guarantees at
  -- most one pending-or-approved timesheet per employee per day — so one
  -- timesheet IS one employee-day. Rejected sheets are superseded rows
  -- and deliberately excluded from comparison this way.
  SELECT e.time_from, e.time_to INTO v_other
  FROM public.timesheet_entries e
  WHERE e.timesheet_id = NEW.timesheet_id
    AND e.id <> NEW.id
    AND e.time_from IS NOT NULL
    AND e.time_to IS NOT NULL
    -- Half-open interval overlap. Adjacency (a.to = b.from) is NOT an
    -- overlap and must stay allowed.
    AND e.time_from < NEW.time_to
    AND e.time_to   > NEW.time_from
  LIMIT 1;

  IF FOUND THEN
    SELECT t.date INTO v_date FROM public.timesheets t WHERE t.id = NEW.timesheet_id;
    RAISE EXCEPTION
      'Timesheet entries cannot overlap: % to % clashes with an existing entry (% to %) on %.',
      to_char(NEW.time_from, 'HH24:MI'), to_char(NEW.time_to, 'HH24:MI'),
      to_char(v_other.time_from, 'HH24:MI'), to_char(v_other.time_to, 'HH24:MI'),
      to_char(v_date, 'DD Mon YYYY');
  END IF;

  RETURN NULL;  -- AFTER/constraint triggers ignore the return value
END;
$$;

-- CREATE CONSTRAINT TRIGGER has no IF NOT EXISTS form, so drop first to
-- stay re-runnable.
DROP TRIGGER IF EXISTS entries_no_time_overlap ON public.timesheet_entries;
CREATE CONSTRAINT TRIGGER entries_no_time_overlap
  AFTER INSERT OR UPDATE ON public.timesheet_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.block_overlapping_entries();

-- ── Verify before continuing ─────────────────────────────────────────
-- Reports pre-existing violations rather than failing on them: the
-- trigger only guards new writes, so anything already in the table stays
-- put and would otherwise be invisible. Wrapped (overnight) rows in
-- particular become un-editable under rule (a) — they can still be read
-- and approved, but any UPDATE touching them will now be rejected.
DO $$
DECLARE v_wrapped INT; v_overlapping INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'entries_no_time_overlap' AND tgrelid = 'public.timesheet_entries'::regclass
  ) THEN
    RAISE EXCEPTION 'v20 verification failed: entries_no_time_overlap trigger missing';
  END IF;

  SELECT COUNT(*) INTO v_wrapped
  FROM public.timesheet_entries
  WHERE time_from IS NOT NULL AND time_to IS NOT NULL AND time_to <= time_from;

  SELECT COUNT(*) INTO v_overlapping
  FROM public.timesheet_entries a
  JOIN public.timesheet_entries b
    ON b.timesheet_id = a.timesheet_id AND b.id <> a.id
   AND b.time_from IS NOT NULL AND b.time_to IS NOT NULL
   AND b.time_from < a.time_to AND b.time_to > a.time_from
  WHERE a.time_from IS NOT NULL AND a.time_to IS NOT NULL;

  IF v_wrapped > 0 THEN
    RAISE WARNING 'v20: % existing entr(y/ies) end at or before they start (overnight/wrapped). They are left as-is, but any future UPDATE to them will now be rejected. Review with the query in this file''s footer.', v_wrapped;
  END IF;

  IF v_overlapping > 0 THEN
    RAISE WARNING 'v20: % existing entry pair-sides overlap another entry on the same timesheet. Left as-is; review with the query in this file''s footer.', v_overlapping;
  END IF;
END $$;

COMMIT;

-- =============================================================
-- Pre-existing violations, if either warning above fired:
--
--   -- Wrapped / inverted ranges
--   SELECT t.date, p.email, e.time_from, e.time_to, e.hours_decimal
--   FROM public.timesheet_entries e
--   JOIN public.timesheets t ON t.id = e.timesheet_id
--   JOIN public.profiles   p ON p.id = t.employee_id
--   WHERE e.time_from IS NOT NULL AND e.time_to IS NOT NULL
--     AND e.time_to <= e.time_from
--   ORDER BY t.date DESC;
--
--   -- Overlapping pairs
--   SELECT t.date, p.email,
--          a.time_from AS a_from, a.time_to AS a_to,
--          b.time_from AS b_from, b.time_to AS b_to
--   FROM public.timesheet_entries a
--   JOIN public.timesheet_entries b
--     ON b.timesheet_id = a.timesheet_id AND b.id > a.id
--    AND b.time_from < a.time_to AND b.time_to > a.time_from
--   JOIN public.timesheets t ON t.id = a.timesheet_id
--   JOIN public.profiles   p ON p.id = t.employee_id
--   WHERE a.time_from IS NOT NULL AND a.time_to IS NOT NULL
--     AND b.time_from IS NOT NULL AND b.time_to IS NOT NULL
--   ORDER BY t.date DESC;
--
-- Left in place deliberately — they predate the rule. Correct via the
-- IT-gated delete-timesheets endpoint and a resubmission if needed.
-- =============================================================
