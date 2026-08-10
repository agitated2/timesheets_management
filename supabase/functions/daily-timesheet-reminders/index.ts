// Deno port of netlify/functions/daily-timesheet-reminders.js (now
// retired) — scheduled hourly via Supabase Cron (see
// supabase/migration_v14_schedule_reminders.sql), not daily: with
// per-office timezones there is no single UTC hour that is 09:00
// everywhere, and DST would shift it anyway. reminder_recipients() in the
// DB decides who is actually due right now.
//
// Auth: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// auto-injected into every Edge Function's environment by the platform —
// nothing to configure for those. Only the GRAPH_* vars and APP_URL need
// `supabase secrets set`.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendMail } from '../_shared/graph-mail.ts'
import { buildReminderEmail, type ReportRow } from '../_shared/reminder-templates.ts'

// Graph enforces ~4 concurrent requests per mailbox — above that, sendMail
// calls start getting 429'd. Was 8, which guaranteed throttling on any run
// with more than a handful of recipients.
const CONCURRENCY = 4
// A reminder_log row from a run that crashed mid-send (timeout, cold-start
// kill) never reaches 'sent' or 'failed' and would otherwise block that
// recipient's claim for the rest of the day under the unique index — treat
// anything still 'pending' after this long as abandoned and reclaimable.
const STALE_PENDING_MS = 15 * 60 * 1000
// Guards fetchAllRpc below against looping forever if a bug ever makes it
// see a same-size page indefinitely — this is 50k rows, far past anything
// this job should ever legitimately return in one run.
const MAX_RPC_PAGES = 50
const jsonHeaders = { 'Content-Type': 'application/json' }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

// supabase-js applies the same Range-header pagination to RPC calls that
// return SETOF/TABLE as it does to regular table queries. Without paging,
// a PostgREST project with `db-max-rows` configured silently truncates the
// result with no error — some employees or recipients would just never be
// reported on, with nothing in the logs to explain why.
async function fetchAllRpc<T>(
  supabase: ReturnType<typeof createClient>,
  fn: string,
  args: Record<string, unknown>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; page < MAX_RPC_PAGES; page++) {
    const from = page * pageSize
    const { data, error } = await supabase.rpc(fn, args).range(from, from + pageSize - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    rows.push(...batch)
    if (batch.length < pageSize) return rows
  }
  throw new Error(`fetchAllRpc(${fn}): exceeded ${MAX_RPC_PAGES} pages — result set unexpectedly large or pagination isn't terminating`)
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

interface Recipient {
  user_id: string
  email: string
  full_name: string | null
  home_office_id: string
  local_business_date: string
  visible_office_ids: string[]
  is_hr: boolean
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' })
  }

  // Only the holder of the actual service-role key can produce this exact
  // match — never shipped to any frontend, and set explicitly (not
  // guessed) in the cron job's own net.http_post headers. Supabase's own
  // platform-level JWT verification (left on, the default) already
  // rejects requests carrying no valid Supabase-signed JWT at all before
  // this code even runs; this check is what turns "any signed JWT" into
  // "specifically our own cron job."
  const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')
  const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'Server misconfigured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from the function environment.' })
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${SERVICE_KEY}`) {
    return json(401, { error: 'Unauthorized' })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const { data: settings, error: settingsErr } = await supabase.from('app_settings').select('*').eq('id', 1).single()
    if (settingsErr) throw settingsErr
    if (!settings?.reminder_enabled) {
      return json(200, { skipped: 'reminders disabled in app_settings' })
    }

    const backlogDays  = settings.reminder_backlog_days ?? 14
    const reminderHour = settings.reminder_hour ?? 9

    // office_id is nullable (added in a later migration than `profiles`
    // itself) and both RPCs below inner-join offices, so anyone with no
    // office silently never gets chased and never appears in anyone's
    // digest — no error, no log line. Surface it instead of letting it be
    // a quiet gap someone only notices weeks later.
    const { count: missingOfficeCount, error: missingOfficeErr } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('onboarding_complete', true)
      .is('office_id', null)
    if (missingOfficeErr) throw missingOfficeErr
    if (missingOfficeCount) {
      console.warn(`daily-timesheet-reminders: ${missingOfficeCount} onboarded profile(s) have no office_id — they are excluded from this run entirely (not reported on, and won't receive digests).`)
    }

    const [report, recipients] = await Promise.all([
      fetchAllRpc<ReportRow>(supabase, 'timesheet_status_report', { p_backlog_days: backlogDays }),
      fetchAllRpc<Recipient>(supabase, 'reminder_recipients', { p_reminder_hour: reminderHour }),
    ])

    if (!recipients.length) {
      return json(200, { sent: 0, note: 'no recipients due this hour', missingOfficeCount: missingOfficeCount || 0 })
    }

    // No Netlify-style auto-injected site URL here — Supabase doesn't
    // host the frontend. Set explicitly via `supabase secrets set
    // APP_URL=https://yourdomain.com`; falls back to a bare path if unset
    // (matches the original's graceful degradation when its env vars
    // were absent) rather than failing the whole run over a cosmetic link.
    const appUrl = Deno.env.get('APP_URL') || ''
    const uploadUrl = appUrl ? `${appUrl.replace(/\/$/, '')}/upload` : '/upload'

    const results = await mapWithConcurrency(recipients, CONCURRENCY, async (recipient) => {
      const visibleSet = new Set(recipient.visible_office_ids || [])
      const allRows = report

      const ownRows = allRows.filter(r => r.employee_id === recipient.user_id)
      // Mirrors the existing profiles_read_subordinates RLS policy:
      // manager_ids contains the recipient AND the report's office is
      // visible to them. A manager never sees a report they couldn't
      // already open in the app.
      const teamRows = allRows.filter(r =>
        r.employee_id !== recipient.user_id &&
        Array.isArray((r as unknown as { manager_ids?: string[] }).manager_ids) &&
        (r as unknown as { manager_ids: string[] }).manager_ids.includes(recipient.user_id) &&
        visibleSet.has(r.office_id)
      )
      const officeRows = recipient.is_hr
        ? allRows.filter(r => r.employee_id !== recipient.user_id && visibleSet.has(r.office_id))
        : []

      if (!ownRows.length && !teamRows.length && !officeRows.length) {
        return { recipient: recipient.email, skipped: 'nothing to report' }
      }

      // Reclaim a stale claim from a run that crashed mid-send (timeout,
      // cold-start kill) — it never reached 'sent' or 'failed', so without
      // this it would block this recipient under the unique index for the
      // rest of the business day with no automatic recovery.
      await supabase
        .from('reminder_log')
        .delete()
        .eq('recipient_id', recipient.user_id)
        .eq('business_date', recipient.local_business_date)
        .eq('status', 'pending')
        .lt('sent_at', new Date(Date.now() - STALE_PENDING_MS).toISOString())

      // Claim this recipient/business_date BEFORE sending — the
      // reminder_log unique index on (recipient_id, business_date) (for
      // any status other than 'failed') is the entire idempotency
      // guarantee. A unique-violation here means this recipient already
      // has a live claim (sent, or a send currently in flight) — skip
      // rather than re-send. A PRIOR 'failed' attempt does NOT block this
      // insert, so a transient error naturally gets retried next hour.
      const { data: logRow, error: claimErr } = await supabase
        .from('reminder_log')
        .insert({
          recipient_id: recipient.user_id,
          recipient_email: recipient.email,
          business_date: recipient.local_business_date,
          status: 'pending',
        })
        .select('id')
        .single()

      if (claimErr) {
        if (claimErr.code === '23505') return { recipient: recipient.email, skipped: 'already logged today' }
        return { recipient: recipient.email, error: claimErr.message }
      }

      const { subject, html, text } = buildReminderEmail({
        recipientName: recipient.full_name,
        uploadUrl,
        ownRows,
        teamRows,
        officeRows,
      })

      try {
        await sendMail({ to: recipient.email, subject, html, text })
        await supabase.from('reminder_log').update({ status: 'sent' }).eq('id', logRow.id)
        return { recipient: recipient.email, sent: true }
      } catch (sendErr) {
        const message = sendErr instanceof Error ? sendErr.message : String(sendErr)
        await supabase.from('reminder_log').update({ status: 'failed', error: message }).eq('id', logRow.id)
        return { recipient: recipient.email, error: message }
      }
    })

    const sent    = results.filter(r => 'sent' in r && r.sent).length
    const skipped = results.filter(r => 'skipped' in r).length
    const failed  = results.filter(r => 'error' in r).length

    return json(200, { sent, skipped, failed, total: recipients.length })
  } catch (err) {
    console.error('daily-timesheet-reminders error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})
