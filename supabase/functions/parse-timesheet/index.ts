// Parses an uploaded XLSX timesheet, validates it against projects/
// leave/disciplines/duplicate-day/future-date rules, and (unless dryRun)
// writes it. Ported from netlify/functions/parse-timesheet.js — the
// request/response plumbing changes (Deno.serve/Response instead of
// Netlify's {statusCode, headers, body} object); every parsing/validation
// function below is unchanged, byte-for-byte logic, since none of them
// touch anything Node-specific.
//
// VERIFY AFTER DEPLOYING: this is the one function in the port that pulls
// in a substantial third-party library (xlsx) via Deno's npm: compat
// layer rather than calling only supabase-js. xlsx is pure JS with no
// native bindings, so it should work, but this couldn't be exercised
// against a real .xlsx file before deploying (no Deno runtime available
// in the environment this was ported from) — test an actual upload,
// including the dry-run preview, before trusting this in production.
// If XLSX.SSF.parse_date_code (used only in the legacy single-day
// fallback format) turns out not to survive the npm: import, that is the
// most likely single point of failure.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import XLSX from 'npm:xlsx@0.18.5'
import { Buffer } from 'node:buffer'
import { json, corsPreflight } from '../_shared/cors.ts'

Deno.serve(async (req: Request) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'Server misconfigured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from the function environment.' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json(401, { error: 'Missing auth token' })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !user) return json(401, { error: 'Invalid token' })

    // XLSX upload is opt-in per deployment (IT Panel → Settings). Checked here
    // too, not just hidden in the UI, since this function is reachable directly
    // regardless of what the client renders.
    const { data: settings } = await supabaseAdmin.from('app_settings').select('xlsx_upload_enabled').eq('id', 1).single()
    if (!settings?.xlsx_upload_enabled) {
      return json(403, { error: 'XLSX upload is disabled. Use in-app timesheet entry.' })
    }

    const { file, fileName, dryRun } = await req.json()
    if (!file) return json(400, { error: 'No file provided' })

    const buffer = Buffer.from(file, 'base64')
    // XLSX.read with cellDates:true mutates cell types in-place (n→d), so a second
    // read without cellDates is required to get raw fractional-day numbers for the
    // Total Hours column (e.g. 0.0833 = 2 h) needed for discrepancy detection.
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const workbookRaw = XLSX.read(buffer, { type: 'buffer' })

    // Prefer a sheet named "Weekly" or "Week"; fall back to first sheet
    const preferredNames = ['weekly', 'week', 'timesheet']
    const sheetName =
      workbook.SheetNames.find((n: string) => preferredNames.includes(n.toLowerCase())) ||
      workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    const sheetRaw = workbookRaw.Sheets[sheetName]

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true })
    const rawRows = XLSX.utils.sheet_to_json(sheetRaw, { header: 1, defval: null, raw: true })

    const { days, discrepancies, missingTasks, wrappedRangeViolations } = parseSheetMultiDay(rows, rawRows)

    if (days.length === 0) {
      return json(400, { error: 'No valid dates or time entries found in the uploaded file.' })
    }

    // ── Dry run: parse only, no DB writes ──────────────────────
    if (dryRun) {
      const preview = days.map((d: any) => ({
        date: d.date,
        entriesCount: d.entries.length,
        hours: round2(d.entries.reduce((s: number, e: any) => s + (e.hours_decimal || 0), 0)),
        entries: d.entries,
      }))
      const projectViolations = await checkProjectViolations(supabaseAdmin, user.id, days)
      const disciplineViolations = await checkDisciplineViolations(supabaseAdmin, days)
      const leaveViolations = await checkLeaveViolations(supabaseAdmin, user.id, days)
      const duplicateDayViolations = await checkDuplicateDayViolations(supabaseAdmin, user.id, days)
      const overlapViolations = checkOverlapViolations(days)
      return json(200, {
        dryRun: true,
        days: preview,
        totalDays: days.length,
        totalHours: round2(preview.reduce((s: number, d: any) => s + d.hours, 0)),
        discrepancies,
        hasDiscrepancies: discrepancies.length > 0,
        missingTasks,
        hasMissingTasks: missingTasks.length > 0,
        projectViolations,
        hasProjectViolations: projectViolations.length > 0,
        disciplineViolations,
        hasDisciplineViolations: disciplineViolations.length > 0,
        leaveViolations,
        hasLeaveViolations: leaveViolations.length > 0,
        duplicateDayViolations,
        hasDuplicateDayViolations: duplicateDayViolations.length > 0,
        overlapViolations,
        hasOverlapViolations: overlapViolations.length > 0,
        wrappedRangeViolations,
        hasWrappedRangeViolations: wrappedRangeViolations.length > 0,
      })
    }

    // ── Block actual upload if the file has discrepancies ───────
    if (discrepancies.length > 0) {
      return json(400, {
        error: `File contains ${discrepancies.length} time discrepanc${discrepancies.length === 1 ? 'y' : 'ies'}. Please fix them before uploading.`,
        discrepancies,
      })
    }

    // ── Block actual upload if any entry is missing a task/description ──
    if (missingTasks.length > 0) {
      return json(400, {
        error: `${missingTasks.length} entr${missingTasks.length === 1 ? 'y is' : 'ies are'} missing a task description. Add one for each entry before uploading.`,
        missingTasks,
      })
    }

    // ── Block actual upload if there are project violations ─────
    const projectViolations = await checkProjectViolations(supabaseAdmin, user.id, days)
    if (projectViolations.length > 0) {
      return json(400, {
        error: `Timesheet has ${projectViolations.length} project access violation${projectViolations.length === 1 ? '' : 's'}. Please resolve them before uploading.`,
        projectViolations,
      })
    }

    // ── Block actual upload if any entry is missing / has an unknown discipline ──
    const disciplineViolations = await checkDisciplineViolations(supabaseAdmin, days)
    if (disciplineViolations.length > 0) {
      return json(400, {
        error: `Timesheet has ${disciplineViolations.length} discipline issue${disciplineViolations.length === 1 ? '' : 's'}. Every entry needs a valid discipline.`,
        disciplineViolations,
      })
    }

    // ── Block actual upload if it overlaps approved leave ───────
    const leaveViolations = await checkLeaveViolations(supabaseAdmin, user.id, days)
    if (leaveViolations.length > 0) {
      return json(400, {
        error: 'You have an approved leave for this date range. Please adjust your timesheet entries.',
        leaveViolations,
      })
    }

    // ── Block actual upload of future-dated rows ────────────────
    const futureDayViolations = await checkFutureDayViolations(supabaseAdmin, user.id, days)
    if (futureDayViolations.length > 0) {
      return json(400, {
        error: `Timesheets cannot be dated in the future. ${futureDayViolations.length === 1 ? 'One date is' : `${futureDayViolations.length} dates are`} after today (${futureDayViolations[0].today}) in your office's time zone.`,
        futureDayViolations,
      })
    }

    // ── Block actual upload if a date already has a pending/approved timesheet ──
    // One timesheet per employee per day — resubmission is only possible once a
    // manager rejects the previous one. The DB's partial unique index is the
    // real guarantee; this check exists so the employee sees it clearly instead
    // of a raw insert-time error.
    const duplicateDayViolations = await checkDuplicateDayViolations(supabaseAdmin, user.id, days)
    if (duplicateDayViolations.length > 0) {
      return json(400, {
        error: `You already have a timesheet awaiting review for ${duplicateDayViolations.length === 1 ? 'this date' : 'these dates'}. You can submit again only if your manager rejects it.`,
        duplicateDayViolations,
      })
    }

    // ── Block wrapped/inverted time ranges ──────────────────────
    // These rows were already dropped during parsing (parseTimeRange
    // returns null for them), so uploading would silently lose hours.
    // Better to refuse and say why. Enforced in the DB by the
    // entries_no_time_overlap trigger (migration v20).
    if (wrappedRangeViolations.length > 0) {
      return json(400, {
        error: `${wrappedRangeViolations.length} entr${wrappedRangeViolations.length === 1 ? 'y ends' : 'ies end'} at or before ${wrappedRangeViolations.length === 1 ? 'it starts' : 'they start'}. An overnight shift must be split into one entry per day.`,
        wrappedRangeViolations,
      })
    }

    // ── Block overlapping entries within a day ──────────────────
    const overlapViolations = checkOverlapViolations(days)
    if (overlapViolations.length > 0) {
      return json(400, {
        error: `${overlapViolations.length} pair${overlapViolations.length === 1 ? '' : 's'} of entries cover overlapping times on the same day. Adjust them so they don't clash.`,
        overlapViolations,
      })
    }

    // ── Resolve canonical project_id / stage_id for each entry ──
    await attachProjectStageIds(supabaseAdmin, days)

    // ── Upload raw file to storage (once, shared across all days) ─
    const safeFileName = (fileName || 'timesheet.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_')
    const filePath = `${user.id}/${Date.now()}_${safeFileName}`
    const { error: storageErr } = await supabaseAdmin.storage
      .from('timesheet-files')
      .upload(filePath, buffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: false,
      })
    if (storageErr) throw new Error(`Storage error: ${storageErr.message}`)

    // ── Insert one timesheet row per day ────────────────────────
    const resultDays = []
    for (const day of days) {
      const totalHours = round2(day.entries.reduce((s: number, e: any) => s + (e.hours_decimal || 0), 0))

      const { data: timesheet, error: tsErr } = await supabaseAdmin
        .from('timesheets')
        .insert({ employee_id: user.id, date: day.date, file_path: filePath, total_hours: totalHours })
        .select()
        .single()
      if (tsErr) throw new Error(`Timesheet insert error for ${day.date}: ${tsErr.message}`)

      const { error: entryErr } = await supabaseAdmin
        .from('timesheet_entries')
        .insert(day.entries.map(({ stage_name, row_number, discipline_name, ...e }: any) => ({ ...e, timesheet_id: timesheet.id })))
      if (entryErr) throw new Error(`Entries insert error for ${day.date}: ${entryErr.message}`)

      resultDays.push({ date: day.date, timesheet, entries: day.entries, hours: totalHours })
    }

    return json(200, {
      days: resultDays,
      totalDays: resultDays.length,
      totalHours: round2(resultDays.reduce((s, d) => s + d.hours, 0)),
    })
  } catch (err) {
    console.error('parse-timesheet error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})

// ---------------------------------------------------------------
// PROJECT VALIDATION
// Checks project existence, membership, stage existence, and stage
// date coverage for each entry. Groups violations by unique issue
// and collects all affected row numbers per violation.
// ---------------------------------------------------------------

async function checkProjectViolations(db: SupabaseClient, userId: string, days: any[]) {
  // Collect all entries that reference a project
  const pairs = []
  for (const day of days) {
    for (const entry of day.entries) {
      if (!entry.project_name) continue
      pairs.push({
        date: day.date,
        project_name: entry.project_name,
        stage_name: entry.stage_name || null,
        row_number: entry.row_number || null,
        hours: Number(entry.hours_decimal) || 0,
      })
    }
  }
  if (pairs.length === 0) return []

  // Load all managed projects (active only) with stages + members + constraints
  const { data: projects } = await db
    .from('projects')
    .select('id, name, tracking_type, total_hours, project_stages(id, name, start_date, end_date, is_archived, allocated_hours), project_members(employee_id)')
    .eq('status', 'active')

  const projectMap = new Map()
  for (const p of (projects || [])) projectMap.set(p.name.toLowerCase(), p)

  // Cumulative logged hours per stage (approved + pending), for hour-pool state
  const loggedByStage = new Map()
  const { data: loggedRows } = await db
    .from('timesheet_entries')
    .select('stage_id, hours_decimal, timesheets!inner(status)')
    .not('stage_id', 'is', null)
    .in('timesheets.status', ['pending', 'approved'])
  for (const r of (loggedRows || [])) {
    loggedByStage.set(r.stage_id, (loggedByStage.get(r.stage_id) || 0) + (Number(r.hours_decimal) || 0))
  }

  // violationMap groups identical issues, collecting row numbers
  // Key: 'type::project::stage::date'
  const violationMap = new Map()

  function addViolation(type: string, project: string, stage: string | null, date: string, row_number: number | null, extra: Record<string, unknown> = {}) {
    const key = `${type}::${project.toLowerCase()}::${(stage || '').toLowerCase()}::${date}`
    if (violationMap.has(key)) {
      if (row_number) violationMap.get(key).rowNumbers.push(row_number)
    } else {
      violationMap.set(key, {
        type, project, stage: stage || null, date,
        rowNumbers: row_number ? [row_number] : [],
        ...extra,
      })
    }
  }

  // Running remaining-pool balance per hour-tracked stage, seeded from the hours
  // already in the DB. Rows are processed chronologically so the "first N hours
  // fit, the rest overflow" rule is deterministic across a bulk file — mirroring
  // the write-time cumulative check in schema.sql.
  const poolBalance = new Map() // stage_id → remaining hours
  const ordered = [...pairs].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.row_number || 0) - (b.row_number || 0)
  )

  for (const { date, project_name, stage_name, row_number, hours } of ordered) {
    const p = projectMap.get(project_name.toLowerCase())

    if (!p) {
      addViolation('project_not_found', project_name, null, date, row_number)
      continue
    }

    // Membership check
    const isMember = (p.project_members || []).some((m: any) => m.employee_id === userId)
    if (!isMember) {
      addViolation('not_member', project_name, null, date, row_number)
      continue
    }

    // Every entry needs a stage — hours can't be logged directly to a project
    if (!stage_name) {
      addViolation('stage_required', project_name, null, date, row_number)
      continue
    }

    const stages = (p.project_stages || []).filter((s: any) => !s.is_archived)
    const matched = stages.find((s: any) => s.name.toLowerCase() === stage_name.toLowerCase())

    if (!matched) {
      addViolation('stage_not_found', project_name, stage_name, date, row_number)
      continue
    }

    // DATE-tracked: block before the stage opens or after it ends (forward-dated).
    // Backdating within [start, end] stays open indefinitely — no grace tail.
    if (p.tracking_type === 'date') {
      if (matched.start_date && date < matched.start_date) {
        addViolation('stage_not_started', project_name, stage_name, date, row_number, { startDate: matched.start_date })
      } else if (matched.end_date && date > matched.end_date) {
        addViolation('stage_ended', project_name, stage_name, date, row_number, { endDate: matched.end_date })
      }
      continue
    }

    // HOURS-tracked: cap against the remaining pool, cumulative within the file.
    if (matched.allocated_hours && matched.allocated_hours > 0) {
      if (!poolBalance.has(matched.id)) {
        poolBalance.set(matched.id, matched.allocated_hours - (loggedByStage.get(matched.id) || 0))
      }
      const remaining = poolBalance.get(matched.id)
      if (remaining <= 0) {
        addViolation('stage_pool_full', project_name, stage_name, date, row_number, { allocated: matched.allocated_hours })
      } else if (hours > remaining) {
        addViolation('stage_pool_exceeded', project_name, stage_name, date, row_number, { remaining: round2(remaining) })
        poolBalance.set(matched.id, 0) // subsequent rows for this stage overflow too
      } else {
        poolBalance.set(matched.id, remaining - hours)
      }
    }
  }

  return [...violationMap.values()]
}

// ---------------------------------------------------------------
// LEAVE VALIDATION
// Flags timesheet dates/entries that overlap an approved leave.
// Daily leave blocks the whole working day; hourly leave blocks
// only overlapping entry time windows. Weekends / public holidays
// are never blocked (working-day check via is_working_day RPC).
// ---------------------------------------------------------------

async function checkLeaveViolations(db: SupabaseClient, userId: string, days: any[]) {
  if (days.length === 0) return []
  const dates = days.map((d) => d.date).sort()
  const min = dates[0], max = dates[dates.length - 1]

  const { data: leaves } = await db
    .from('leave_requests')
    .select('unit, start_date, end_date, start_time, end_time')
    .eq('employee_id', userId)
    .eq('status', 'approved')
    .lte('start_date', max)
    .gte('end_date', min)

  if (!leaves || leaves.length === 0) return []

  const dailyLeaves = leaves.filter((l) => l.unit === 'daily')
  const hourlyLeaves = leaves.filter((l) => l.unit === 'hourly')
  const violations = []

  for (const day of days) {
    // Daily leave → whole working day blocked
    const covering = dailyLeaves.find((l) => day.date >= l.start_date && day.date <= l.end_date)
    if (covering) {
      const { data: working } = await db.rpc('is_working_day', { emp: userId, d: day.date })
      if (working) { violations.push({ type: 'leave_day', date: day.date }); continue }
    }
    // Hourly leave → overlapping entry windows blocked
    for (const lv of hourlyLeaves.filter((l) => l.start_date === day.date)) {
      const lvFrom = (lv.start_time || '').slice(0, 5)
      const lvTo = (lv.end_time || '').slice(0, 5)
      for (const e of day.entries) {
        if (!e.time_from || !e.time_to) continue
        if (lvFrom < e.time_to && lvTo > e.time_from) {
          violations.push({ type: 'leave_hours', date: day.date, timeRange: `${lvFrom}–${lvTo}` })
          break
        }
      }
    }
  }
  return violations
}

// ---------------------------------------------------------------
// DUPLICATE-DAY VALIDATION
// An employee may hold at most one pending-or-approved timesheet per date
// (enforced at the DB level by a partial unique index — see migration_v8).
// Flags any day in this upload that already has one, so the employee sees
// a clear message instead of a raw insert-time error.
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// OVERLAP VALIDATION
// No two entries on the same day may cover overlapping clock time
// (migration v20). Purely in-memory — it compares the parsed file
// against itself; the DB trigger is the guarantee, this exists so the
// user sees which rows clash instead of one Postgres error naming a
// single pair.
//
// Note this cannot catch a wrapped/inverted range, because
// parseTimeRange() drops those before they ever reach here — see
// wrappedRangeViolations, built during parsing instead.
// ---------------------------------------------------------------

function checkOverlapViolations(days: any[]) {
  const violations = []
  for (const day of days) {
    const timed = (day.entries || []).filter((e: any) => e.time_from && e.time_to)
    for (let i = 0; i < timed.length; i++) {
      for (let j = i + 1; j < timed.length; j++) {
        const a = timed[i], b = timed[j]
        // Half-open: adjacency (a.to === b.from) is not an overlap.
        if (a.time_from < b.time_to && a.time_to > b.time_from) {
          violations.push({
            date: day.date,
            rowNumbers: [a.row_number, b.row_number].filter(Boolean),
            rangeA: `${a.time_from}–${a.time_to}`,
            rangeB: `${b.time_from}–${b.time_to}`,
          })
        }
      }
    }
  }
  return violations
}

async function checkDuplicateDayViolations(db: SupabaseClient, userId: string, days: any[]) {
  if (days.length === 0) return []
  const dates = days.map((d) => d.date)
  const { data: existing } = await db
    .from('timesheets')
    .select('date')
    .eq('employee_id', userId)
    .in('date', dates)
    .in('status', ['pending', 'approved'])
  return (existing || []).map((e) => ({ date: e.date }))
}

// Future-dated rows. Judged against the uploader's OWN OFFICE local date,
// matching the timesheets_block_future trigger exactly (migration_v17) —
// the server's own clock is UTC and would wrongly reject a legitimate
// same-day entry for any office ahead of it. The trigger is the real
// guarantee; this exists so the employee gets a clear per-date message
// instead of a raw insert-time error on the first offending row.
async function checkFutureDayViolations(db: SupabaseClient, userId: string, days: any[]) {
  if (days.length === 0) return []

  const { data: profile } = await db
    .from('profiles')
    .select('office_id, offices(timezone)')
    .eq('id', userId)
    .single()

  // UTC fallback mirrors the trigger's COALESCE(v_zone, 'UTC') — never
  // ahead of any office, so it can't hand out extra days.
  const zone = (profile as any)?.offices?.timezone || 'UTC'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  const today = `${map.year}-${map.month}-${map.day}`

  return days.filter((d) => d.date > today).map((d) => ({ date: d.date, today }))
}

// ---------------------------------------------------------------
// Resolve canonical project_id / stage_id for each parsed entry so
// the HR review page can filter reliably. Names are matched against
// active projects and their non-archived stages (case-insensitive).
// ---------------------------------------------------------------

async function attachProjectStageIds(db: SupabaseClient, days: any[]) {
  const { data: projects } = await db
    .from('projects')
    .select('id, name, project_stages(id, name, is_archived)')
    .eq('status', 'active')

  const pmap = new Map()
  for (const p of (projects || [])) pmap.set(p.name.toLowerCase(), p)

  const { data: discs } = await db.from('disciplines').select('id, name').eq('is_active', true)
  const dmap = new Map((discs || []).map((d) => [d.name.toLowerCase(), d.id]))

  for (const day of days) {
    for (const e of day.entries) {
      e.project_id = null
      e.stage_id = null
      e.discipline_id = e.discipline_name ? (dmap.get(e.discipline_name.toLowerCase()) || null) : null
      if (!e.project_name) continue
      const p = pmap.get(e.project_name.toLowerCase())
      if (!p) continue
      e.project_id = p.id
      if (e.stage_name) {
        const stage = (p.project_stages || [])
          .filter((s: any) => !s.is_archived)
          .find((s: any) => s.name.toLowerCase() === e.stage_name.toLowerCase())
        if (stage) e.stage_id = stage.id
      }
    }
  }
}

// ---------------------------------------------------------------
// DISCIPLINE VALIDATION
// Every entry must name a discipline that matches an active one.
// ---------------------------------------------------------------
async function checkDisciplineViolations(db: SupabaseClient, days: any[]) {
  const { data: discs } = await db.from('disciplines').select('id, name').eq('is_active', true)
  const byName = new Map((discs || []).map((d) => [d.name.toLowerCase(), d.id]))

  const violationMap = new Map()
  function add(type: string, name: string | null, date: string, row: number | null) {
    const key = `${type}::${(name || '').toLowerCase()}::${date}`
    if (violationMap.has(key)) {
      if (row) violationMap.get(key).rowNumbers.push(row)
    } else {
      violationMap.set(key, { type, discipline: name || null, date, rowNumbers: row ? [row] : [] })
    }
  }

  for (const day of days) {
    for (const e of day.entries) {
      if (!e.discipline_name) {
        add('discipline_required', null, day.date, e.row_number || null)
      } else if (!byName.has(e.discipline_name.toLowerCase())) {
        add('discipline_not_found', e.discipline_name, day.date, e.row_number || null)
      }
    }
  }
  return [...violationMap.values()]
}

// ---------------------------------------------------------------
// TOP-LEVEL DISPATCHER
// ---------------------------------------------------------------

// wrappedRangeViolations is only populated by the weekly-table format —
// it's the only one that tracks Excel row numbers, and the only one where
// a dropped row is worth explaining precisely. The section/legacy formats
// already tolerate entries with null times, so a wrapped range there
// degrades to "no times recorded" rather than a vanished row.
function parseSheetMultiDay(rows: any[], rawRows: any[]) {
  // 1. Standard columnar weekly table (Day | Date | Project | Stage | Time | Description)
  const result = tryParseWeeklyTableFormat(rows, rawRows)
  if (result.days.length > 0) return result

  // 2. Section-based: explicit "Date:" label rows
  const sectionDays = tryParseSectionFormat(rows)
  if (sectionDays.length > 0) return { days: sectionDays, discrepancies: [], missingTasks: collectMissingTasks(sectionDays), wrappedRangeViolations: [] }

  // 3. Legacy single-day fallback
  const legacy = parseLegacySingleDay(rows)
  if (legacy.date && legacy.entries.length > 0) {
    const days = [{ date: legacy.date, entries: legacy.entries }]
    return { days, discrepancies: [], missingTasks: collectMissingTasks(days), wrappedRangeViolations: [] }
  }

  return { days: [], discrepancies: [], missingTasks: [], wrappedRangeViolations: [] }
}

// Every entry must carry a task/description. For the section/legacy formats the
// task IS the description column, so an empty `task` is the missing-description
// signal (these formats don't track Excel row numbers).
function collectMissingTasks(days: any[]) {
  const out = []
  for (const day of days) {
    for (const e of (day.entries || [])) {
      if (!e.task || !String(e.task).trim()) {
        out.push({ date: day.date, rowNumber: e.row_number || null, project: e.project_name || '(unknown)' })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------
// FORMAT 1 — Columnar weekly table
//
// Detects any sheet where a header row (within the first 10 rows)
// contains "Day" and "Date" columns.  The Day cell (Sun/Mon/Tue…)
// marks the start of each day's block; entries span multiple rows
// under the same day.  Two side-by-side week blocks are both parsed.
//
// Also compares each entry's calculated hours against the Total Hours
// column (read from rawRows as a fractional-day serial — e.g. 0.14583
// = 3.5 h).  Mismatches > 0.1 h are collected as discrepancies.
// ---------------------------------------------------------------

function tryParseWeeklyTableFormat(rows: any[], rawRows: any[]) {
  const DAY_NAMES = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])

  let headerRowIdx = -1
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const lower = rows[i].map((c: unknown) => String(c || '').toLowerCase().trim())
    if (lower.includes('day') && lower.includes('date')) {
      headerRowIdx = i
      break
    }
  }
  if (headerRowIdx === -1) return { days: [], discrepancies: [] }

  const hdrs = rows[headerRowIdx].map((c: unknown) => String(c || '').toLowerCase().trim())

  const blocks = []
  for (let c = 0; c < hdrs.length; c++) {
    if (hdrs[c] !== 'day') continue
    if (c + 1 >= hdrs.length || hdrs[c + 1] !== 'date') continue

    const findNear = (keyword: string) => {
      for (let k = c; k < Math.min(hdrs.length, c + 10); k++) {
        if (hdrs[k] === keyword || hdrs[k].startsWith(keyword)) return k
      }
      return -1
    }

    const timeCol = findNear('time')
    if (timeCol === -1) continue

    blocks.push({
      dayCol: c,
      dateCol: c + 1,
      projectCol: findNear('project'),
      stageCol: findNear('stage'),
      disciplineCol: findNear('discipline') !== -1 ? findNear('discipline') : findNear('department'),
      totalHoursCol: findNear('total'),
      timeCol,
      descCol: findNear('description') !== -1 ? findNear('description') : findNear('desc'),
    })
  }

  if (blocks.length === 0) return { days: [], discrepancies: [] }

  const dayMap = new Map()
  const discrepancies = []
  const missingTasks = []
  const wrappedRangeViolations = []

  for (const block of blocks) {
    let currentDate: string | null = null

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i]
      const dayCell = String(row[block.dayCol] || '').trim()

      if (/^total/i.test(dayCell)) break

      const dayKey = dayCell.toLowerCase().slice(0, 3)
      if (DAY_NAMES.has(dayKey)) {
        const rawDate = row[block.dateCol]
        const d = rawDate ? normalizeDate(rawDate) : null
        if (d) currentDate = d
      }

      if (!currentDate) continue

      const rawTime = block.timeCol !== -1 ? row[block.timeCol] : null
      if (!rawTime || rawTime instanceof Date) continue
      const timeStr = String(rawTime).trim()
      if (!timeStr) continue

      const parsed = parseTimeRange(timeStr)
      if (!parsed) {
        // parseTimeRange now returns null for a wrapped/inverted range
        // (22:00-02:00) as well as for genuinely unparseable text. Only
        // the former is worth reporting — otherwise the row silently
        // disappears and the user has no idea why their hours are short.
        const wrapped = inspectTimeRange(timeStr)
        if (wrapped) {
          wrappedRangeViolations.push({
            date: currentDate,
            rowNumber: i + 1,
            timeRange: `${wrapped.from}–${wrapped.to}`,
          })
        }
        continue
      }

      const projectStr = block.projectCol !== -1 ? String(row[block.projectCol] || '').trim() : ''
      const stageStr = block.stageCol !== -1 ? String(row[block.stageCol] || '').trim() : ''
      const disciplineStr = block.disciplineCol !== -1 ? String(row[block.disciplineCol] || '').trim() : ''
      const descStr = block.descCol !== -1 ? String(row[block.descCol] || '').trim() : ''

      // Stage is stored separately (stage_id); task holds the description only.
      const task = descStr || null

      // ── Discrepancy check ─────────────────────────────────────
      // Total Hours may be stored as a fractional-day serial (e.g. 0.0833 = 2 h)
      // or as a plain decimal (e.g. 2.0). Mismatches > 0.1 h are flagged.
      if (block.totalHoursCol !== -1 && rawRows?.[i]) {
        const rawTotal = rawRows[i][block.totalHoursCol]
        if (typeof rawTotal === 'number' && rawTotal > 0 && rawTotal <= 24) {
          const statedHours = rawTotal < 1 ? round2(rawTotal * 24) : round2(rawTotal)
          if (Math.abs(parsed.hours - statedHours) > 0.1) {
            discrepancies.push({
              date: currentDate,
              rowNumber: i + 1,
              project: projectStr || '(unknown)',
              timeRange: `${parsed.from} – ${parsed.to}`,
              calculatedHours: parsed.hours,
              statedHours,
            })
          }
        }
      }

      // Task/description is mandatory for every entry.
      if (!descStr) {
        missingTasks.push({ date: currentDate, rowNumber: i + 1, project: projectStr || '(unknown)' })
      }

      if (!dayMap.has(currentDate)) dayMap.set(currentDate, [])
      dayMap.get(currentDate).push({
        time_from: parsed.from,
        time_to: parsed.to,
        hours_decimal: parsed.hours,
        project_name: projectStr || null,
        stage_name: stageStr || null, // validation only, stripped before DB insert
        discipline_name: disciplineStr || null, // resolved to discipline_id before insert
        row_number: i + 1, // Excel row for violation reporting, stripped before DB insert
        task,
      })
    }
  }

  const days = [...dayMap.entries()]
    .filter(([, entries]) => (entries as unknown[]).length > 0)
    .sort(([a], [b]) => (a as string).localeCompare(b as string))
    .map(([date, entries]) => ({ date, entries }))

  return { days, discrepancies, missingTasks, wrappedRangeViolations }
}

// ---------------------------------------------------------------
// FORMAT 2 — Section-based (explicit "Date:" label rows)
// ---------------------------------------------------------------

function tryParseSectionFormat(rows: any[]) {
  const markers = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    for (let j = 0; j < row.length; j++) {
      const cell = row[j]
      const cellStr = String(cell || '').trim()
      let d = null

      if (/^date\s*:?\s*$/i.test(cellStr) && j + 1 < row.length) {
        d = normalizeDate(row[j + 1])
      } else if (/^date\s*:\s*.+/i.test(cellStr)) {
        d = normalizeDate(cellStr.replace(/^date\s*:\s*/i, ''))
      }

      if (d) { markers.push({ rowIdx: i, date: d }); break }
    }
  }

  if (markers.length === 0) return []

  const days = []
  for (let m = 0; m < markers.length; m++) {
    const start = markers[m].rowIdx
    const end = m + 1 < markers.length ? markers[m + 1].rowIdx : rows.length
    const entries = parseSectionEntries(rows.slice(start, end))
    if (entries.length > 0) days.push({ date: markers[m].date, entries })
  }
  return days
}

function parseSectionEntries(rows: any[]) {
  const TIME_KW = ['time', 'hours', 'from', 'duration']
  const PROJECT_KW = ['project', 'work', 'client']
  const TASK_KW = ['task', 'description', 'detail', 'activity']
  const DISCIPLINE_KW = ['discipline', 'department']

  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map((c: unknown) => String(c).toLowerCase().trim())
    const hasTime = lower.some((h: string) => TIME_KW.some((k) => h.includes(k)))
    const hasProject = lower.some((h: string) => PROJECT_KW.some((k) => h.includes(k)))
    if (hasTime && hasProject) { headerRowIdx = i; break }
  }
  if (headerRowIdx === -1) return []

  const hdrs = rows[headerRowIdx].map((c: unknown) => String(c).toLowerCase().trim())
  const timeIdx = findColIdx(hdrs, TIME_KW)
  const projectIdx = findColIdx(hdrs, PROJECT_KW)
  const taskIdx = findColIdx(hdrs, TASK_KW)
  const disciplineIdx = findColIdx(hdrs, DISCIPLINE_KW)

  const entries = []
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row.some((c: unknown) => c !== '' && c !== null && c !== undefined)) continue

    const rawTime = timeIdx !== -1 ? String(row[timeIdx] || '').trim() : ''
    const rawProject = projectIdx !== -1 ? String(row[projectIdx] || '').trim() : ''
    const rawTask = taskIdx !== -1 ? String(row[taskIdx] || '').trim() : ''
    const rawDiscipline = disciplineIdx !== -1 ? String(row[disciplineIdx] || '').trim() : ''

    if (!rawTime && !rawProject) continue

    const parsed = parseTimeRange(rawTime)
    entries.push({
      time_from: parsed?.from ?? null,
      time_to: parsed?.to ?? null,
      hours_decimal: parsed?.hours ?? null,
      project_name: rawProject || null,
      discipline_name: rawDiscipline || null,
      task: rawTask || null,
    })
  }
  return entries
}

// ---------------------------------------------------------------
// FORMAT 3 — Legacy single-day fallback
// ---------------------------------------------------------------

function parseLegacySingleDay(rows: any[]) {
  const TIME_KW = ['time', 'hours', 'from', 'duration']
  const PROJECT_KW = ['project', 'work', 'client']

  let date: string | null = null
  let headerRowIdx = -1

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]

    if (!date && i < 5) {
      for (let j = 0; j < row.length; j++) {
        const cell = row[j]
        const cellStr = String(cell).trim()

        if (/^date\s*:?\s*$/i.test(cellStr) && j + 1 < row.length) {
          date = normalizeDate(row[j + 1]); break
        }
        if (/^date\s*:\s*.+/i.test(cellStr)) {
          date = normalizeDate(cellStr.replace(/^date\s*:\s*/i, '')); break
        }
        if (!date && cell instanceof Date) {
          date = normalizeDate(cell); break
        }
        if (!date && typeof cell === 'number' && cell > 40000 && cell < 60000) {
          const d = XLSX.SSF.parse_date_code(cell)
          if (d) { date = `${d.y}-${pad(d.m)}-${pad(d.d)}`; break }
        }
        if (!date && isDateString(cellStr)) date = normalizeDate(cellStr)
      }
    }

    if (headerRowIdx === -1) {
      const lower = row.map((c: unknown) => String(c).toLowerCase().trim())
      const hasTime = lower.some((h: string) => TIME_KW.some((k) => h.includes(k)))
      const hasProject = lower.some((h: string) => PROJECT_KW.some((k) => h.includes(k)))
      if (hasTime && hasProject) headerRowIdx = i
    }

    if (date && headerRowIdx !== -1) break
  }

  const entries = headerRowIdx !== -1 ? parseSectionEntries(rows.slice(headerRowIdx)) : []
  return { date, entries }
}

// ---------------------------------------------------------------
// SHARED UTILITIES
// ---------------------------------------------------------------

function findColIdx(headers: string[], keywords: string[]) {
  for (const kw of keywords) {
    const idx = headers.findIndex((h) => h.includes(kw))
    if (idx !== -1) return idx
  }
  return -1
}

function parseTimeRange(raw: unknown) {
  if (!raw || raw instanceof Date) return null

  const s = String(raw).trim()
    .replace(/\s+to\s+/gi, '~')
    .replace(/\s*[-–—]\s*/g, '~')

  const parts = s.split('~')
  if (parts.length < 2) return null

  const from = parseTimeDecimal(parts[0].trim())
  const to = parseTimeDecimal(parts[parts.length - 1].trim())
  if (from === null || to === null) return null

  // Deliberately does NOT wrap past midnight any more. It used to do
  // `if (hours < 0) hours += 24`, making 22:00-02:00 a valid 4h entry —
  // the entries_no_time_overlap trigger (migration v20) now rejects
  // that, so wrapping here would parse a row the database refuses.
  // Returning null makes the row fall out of parsing entirely, exactly
  // as an unparseable time range already does; checkOverlapViolations()
  // below reports the range explicitly so the user isn't left wondering
  // why a row vanished.
  const hours = to - from
  if (hours <= 0) return null

  return {
    from: decimalToHHMM(from),
    to: decimalToHHMM(to),
    hours: Math.round(hours * 100) / 100,
  }
}

// Detects a wrapped/inverted range BEFORE parseTimeRange discards it, so
// the dry-run can explain what happened rather than silently dropping the
// row. Mirrors parseTimeRange's own splitting so the two agree on what
// counts as a range at all.
function inspectTimeRange(raw: unknown): { from: string; to: string } | null {
  if (!raw || raw instanceof Date) return null
  const s = String(raw).trim()
    .replace(/\s+to\s+/gi, '~')
    .replace(/\s*[-–—]\s*/g, '~')
  const parts = s.split('~')
  if (parts.length < 2) return null
  const from = parseTimeDecimal(parts[0].trim())
  const to = parseTimeDecimal(parts[parts.length - 1].trim())
  if (from === null || to === null) return null
  if (to - from > 0) return null   // valid range, nothing to report
  return { from: decimalToHHMM(from), to: decimalToHHMM(to) }
}

function parseTimeDecimal(s: string): number | null {
  const clean = s.trim().replace(/\s+/g, ' ')

  // 12-hour: "2:30 PM", "2PM", "2:30pm"
  const m12 = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (m12) {
    let h = parseInt(m12[1], 10)
    const m = m12[2] ? parseInt(m12[2], 10) : 0
    const mer = m12[3].toLowerCase()
    if (mer === 'pm' && h !== 12) h += 12
    if (mer === 'am' && h === 12) h = 0
    return h + m / 60
  }

  // HH:MM:SS — strip seconds ("1:30:00", "13:30:00")
  const m24s = clean.match(/^(\d{1,2}):(\d{2}):\d{2}$/)
  if (m24s) return parseInt(m24s[1], 10) + parseInt(m24s[2], 10) / 60

  // HH:MM — 24-hour ("14:30", "09:00")
  const m24 = clean.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1], 10) + parseInt(m24[2], 10) / 60

  // Bare integer hour
  const mH = clean.match(/^(\d{1,2})$/)
  if (mH) return parseInt(mH[1], 10)

  // Excel fractional day (0.375 = 09:00)
  const n = parseFloat(clean)
  if (!isNaN(n) && n >= 0 && n < 1) return n * 24

  return null
}

function decimalToHHMM(dec: number) {
  const h = Math.floor(dec)
  const m = Math.round((dec - h) * 60)
  return `${pad(h)}:${pad(m)}`
}

function normalizeDate(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return toISODate(val)
  const s = String(val).trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  const slash = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/)
  if (slash) {
    const a = parseInt(slash[1], 10)
    const b = parseInt(slash[2], 10)
    const y = slash[3]
    return a > 12 ? `${y}-${pad(b)}-${pad(a)}` : `${y}-${pad(a)}-${pad(b)}`
  }

  const d = new Date(s)
  if (!isNaN(d.getTime())) return toISODate(d)
  return null
}

function isDateString(s: string) {
  if (s.length < 6) return false
  return /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}$/.test(s)
}

function toISODate(d: Date) {
  // Excel Date objects from timezone-aware workbooks (e.g. UAE UTC+4) arrive with a
  // UTC timestamp near-but-before midnight (19:59 UTC = 23:59 local).  Adding 12 h
  // before extracting the UTC date recovers the intended calendar date regardless of
  // which timezone the server is in.
  const shifted = new Date(d.getTime() + 12 * 3600 * 1000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

function pad(n: number) { return String(n).padStart(2, '0') }

function round2(n: number) { return Math.round(n * 100) / 100 }
