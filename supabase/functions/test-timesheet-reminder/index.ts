// Lets an IT admin fire a one-off reminder email from the Admin > Settings
// screen, without waiting for the next hourly cron tick or touching
// reminder_log's once-per-day idempotency guarantee. Every config change
// to reminder_hour/timezone/deadline otherwise costs a full day's feedback
// loop before you can see the result.
//
// Two independent choices, both optional:
//   - targetUserId: whose report gets built (own/team/office rows) — lets
//     you preview what a specific manager or HR user would actually see,
//     not just your own. Defaults to the caller.
//   - deliverTo: the real mailbox that receives it. Defaults to the
//     target's own `email` column, which in a dev/staging dataset is
//     often not a real mailbox at all — this lets you route the preview
//     to an address you can actually check.
// Authorization for BOTH is the same my_has_role('it') check below — an IT
// admin can already see every employee's timesheet status through the app
// itself, so previewing-as-anyone here grants no new visibility.
//
// Unlike daily-timesheet-reminders, this is called directly from the
// browser with the admin's own Supabase session (anon key + user JWT) —
// supabase-js's functions.invoke() attaches that automatically. There is
// no service-role bearer check here; authorization is the my_has_role('it')
// check below, evaluated against whoever the JWT actually belongs to.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendMail } from '../_shared/graph-mail.ts'
import { buildReminderEmail, type ReportRow } from '../_shared/reminder-templates.ts'
import { json, corsPreflight } from '../_shared/cors.ts'

// Deliberately loose — this only gatekeeps obvious typos before spending a
// Graph call; Graph itself is the real authority on deliverability.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

Deno.serve(async (req: Request) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const SERVICE_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
    return json(500, { error: 'Server misconfigured: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing from the function environment.' })
  }

  const authHeader = req.headers.get('Authorization') ?? ''

  // Authed AS the calling user (anon key + their JWT) purely to resolve
  // who they are and confirm the JWT is actually valid — RLS on profiles
  // doesn't matter here since the IT check below re-verifies server-side
  // via a SECURITY DEFINER RPC, not by trusting anything the client sent.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData?.user) {
    return json(401, { error: 'Unauthorized' })
  }

  // Service-role client for the actual data access — timesheet_status_report
  // is REVOKEd from PUBLIC (see migration_v13), so the calling user's own
  // JWT could never read it directly even if authorized. IT-gating happens
  // via my_has_role('it') below instead, called through the user's own
  // session so it evaluates against the right auth.uid().
  const { data: isIt, error: roleErr } = await userClient.rpc('my_has_role', { r: 'it' })
  if (roleErr) return json(500, { error: roleErr.message })
  if (!isIt) return json(403, { error: 'IT role required.' })

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Body is entirely optional — an empty POST previews-and-sends-to-self,
  // matching the original behavior.
  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const targetUserId = typeof body.targetUserId === 'string' && body.targetUserId ? body.targetUserId : userData.user.id
  const deliverToOverride = typeof body.deliverTo === 'string' ? body.deliverTo.trim() : ''
  if (deliverToOverride && !EMAIL_RE.test(deliverToOverride)) {
    return json(400, { error: `"${deliverToOverride}" doesn't look like a valid email address.` })
  }

  try {
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('id, email, full_name, office_id')
      .eq('id', targetUserId)
      .single()
    if (profileErr) {
      return json(400, { error: `Could not find that user (${profileErr.message}).` })
    }
    if (!profile.office_id) {
      return json(400, { error: `${profile.full_name || profile.email} has no office assigned, so a business date cannot be computed for them.` })
    }

    const { data: settings, error: settingsErr } = await supabase.from('app_settings').select('*').eq('id', 1).single()
    if (settingsErr) throw settingsErr
    const backlogDays = settings?.reminder_backlog_days ?? 2

    const [{ data: report, error: reportErr }, { data: recipientRows, error: recErr }] = await Promise.all([
      supabase.rpc('timesheet_status_report', { p_backlog_days: backlogDays }),
      // p_reminder_hour: -1 so the target's row comes back regardless of
      // what hour it is right now — a test send should work at any time
      // of day, not just after their office's send hour.
      supabase.rpc('reminder_recipients', { p_reminder_hour: -1 }),
    ])
    if (reportErr) throw reportErr
    if (recErr) throw recErr

    const recipient = (recipientRows || []).find((r: { user_id: string }) => r.user_id === profile.id)
    if (!recipient) {
      return json(400, { error: `Could not resolve a recipient record for ${profile.full_name || profile.email} — check that their office is active.` })
    }

    const visibleSet = new Set(recipient.visible_office_ids || [])
    const allRows = (report || []) as ReportRow[]
    const ownRows = allRows.filter(r => r.employee_id === profile.id)
    const teamRows = allRows.filter(r =>
      r.employee_id !== profile.id &&
      Array.isArray((r as unknown as { manager_ids?: string[] }).manager_ids) &&
      (r as unknown as { manager_ids: string[] }).manager_ids.includes(profile.id) &&
      visibleSet.has(r.office_id)
    )
    const officeRows = recipient.is_hr
      ? allRows.filter(r => r.employee_id !== profile.id && visibleSet.has(r.office_id))
      : []

    const appUrl = Deno.env.get('APP_URL') || ''
    const uploadUrl = appUrl ? `${appUrl.replace(/\/$/, '')}/upload` : '/upload'

    const { subject, html, text } = buildReminderEmail({
      recipientName: profile.full_name,
      uploadUrl,
      ownRows,
      teamRows,
      officeRows,
    })

    const deliverTo = deliverToOverride || profile.email

    // Deliberately bypasses reminder_log entirely — this is a manual
    // preview, not a real delivery, and must never consume the day's
    // idempotency slot or a real run would then skip this person as
    // "already logged today".
    await sendMail({
      to: deliverTo,
      subject: `[TEST — previewing ${profile.full_name || profile.email}] ${subject}`,
      html,
      text,
    })

    return json(200, {
      sent: true,
      previewing: profile.full_name || profile.email,
      to: deliverTo,
      ownRows: ownRows.length,
      teamRows: teamRows.length,
      officeRows: officeRows.length,
    })
  } catch (err) {
    console.error('test-timesheet-reminder error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})
