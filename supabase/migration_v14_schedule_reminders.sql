-- =============================================================
-- Migration v14: Schedule the timesheet-reminder Edge Function via
-- Supabase Cron
--
-- The reminder job moved from a Netlify Scheduled Function to a Supabase
-- Edge Function (supabase/functions/daily-timesheet-reminders) as part of
-- moving the frontend off Netlify entirely. This migration registers the
-- hourly trigger — the actual reminder logic lives in the Edge Function,
-- not here; this file only wires the schedule up.
--
-- PREREQUISITE — run manually in the SQL editor BEFORE this migration,
-- and do NOT put it in a migration file: it contains real secret values
-- that must never land in git history.
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service_role key from Settings -> API>', 'service_role_key');
--
-- This migration only ever *references* those secrets by name via
-- vault.decrypted_secrets — the value itself never appears here, so this
-- file is safe to commit.
--
-- cron.schedule() upserts by job name, so re-running this is safe and
-- idempotent — it updates the existing job in place rather than
-- duplicating it.
-- =============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Hourly, not daily — with per-office timezones there is no single UTC
-- hour that is 09:00 everywhere, and DST would shift it anyway.
-- reminder_recipients() inside the function decides who is actually due
-- right now; see supabase/migration_v13_timesheet_reminders.sql.
SELECT cron.schedule(
  'daily-timesheet-reminders',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
           || '/functions/v1/daily-timesheet-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    timeout_milliseconds := 25000
  ) AS request_id;
  $$
);

-- Verify the prerequisite Vault secrets actually exist before continuing —
-- a job scheduled against missing secrets would silently fail every hour
-- with no obvious cause.
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM vault.decrypted_secrets WHERE name IN ('project_url', 'service_role_key');
  IF v_count < 2 THEN
    RAISE EXCEPTION 'Missing Vault secret(s) — run the vault.create_secret(...) statements in this file''s header comment first (% of 2 found)', v_count;
  END IF;
END $$;

COMMIT;
