const { createClient } = require('@supabase/supabase-js')
const XLSX = require('xlsx')

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing auth token' }) }
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }

    const { file, fileName, dryRun } = JSON.parse(event.body)
    if (!file) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No file provided' }) }

    const buffer = Buffer.from(file, 'base64')
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })

    // Prefer a sheet named "Weekly" or "Week"; fall back to first sheet
    const preferredNames = ['weekly', 'week', 'timesheet']
    const sheetName =
      workbook.SheetNames.find(n => preferredNames.includes(n.toLowerCase())) ||
      workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false })

    const days = parseSheetMultiDay(rawRows)

    if (days.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid dates or time entries found in the uploaded file.' }) }
    }

    // ── Dry run: parse only, no DB writes ──────────────────────
    if (dryRun) {
      const preview = days.map(d => ({
        date: d.date,
        entriesCount: d.entries.length,
        hours: round2(d.entries.reduce((s, e) => s + (e.hours_decimal || 0), 0)),
      }))
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          dryRun: true,
          days: preview,
          totalDays: days.length,
          totalHours: round2(preview.reduce((s, d) => s + d.hours, 0)),
        }),
      }
    }

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
      const totalHours = round2(day.entries.reduce((s, e) => s + (e.hours_decimal || 0), 0))

      const { data: timesheet, error: tsErr } = await supabaseAdmin
        .from('timesheets')
        .insert({ employee_id: user.id, date: day.date, file_path: filePath, total_hours: totalHours })
        .select()
        .single()
      if (tsErr) throw new Error(`Timesheet insert error for ${day.date}: ${tsErr.message}`)

      const { error: entryErr } = await supabaseAdmin
        .from('timesheet_entries')
        .insert(day.entries.map(e => ({ ...e, timesheet_id: timesheet.id })))
      if (entryErr) throw new Error(`Entries insert error for ${day.date}: ${entryErr.message}`)

      resultDays.push({ date: day.date, timesheet, entries: day.entries, hours: totalHours })
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        days: resultDays,
        totalDays: resultDays.length,
        totalHours: round2(resultDays.reduce((s, d) => s + d.hours, 0)),
      }),
    }
  } catch (err) {
    console.error('parse-timesheet error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}

// ---------------------------------------------------------------
// TOP-LEVEL DISPATCHER
// Tries formats in priority order; first one with results wins.
// ---------------------------------------------------------------

function parseSheetMultiDay(rows) {
  // 1. Standard columnar weekly table (Day | Date | Project | Stage | Time | Description)
  //    This is the primary company format — two side-by-side week blocks per sheet.
  const weekly = tryParseWeeklyTableFormat(rows)
  if (weekly.length > 0) return weekly

  // 2. Section-based format: explicit "Date:" label rows divide day sections.
  const sectionBased = tryParseSectionFormat(rows)
  if (sectionBased.length > 0) return sectionBased

  // 3. Legacy single-day fallback (original logic).
  const legacy = parseLegacySingleDay(rows)
  if (legacy.date && legacy.entries.length > 0) {
    return [{ date: legacy.date, entries: legacy.entries }]
  }

  return []
}

// ---------------------------------------------------------------
// FORMAT 1 — Columnar weekly table
//
// Detects any sheet where a header row contains "Day" and "Date"
// columns. The Day cell (Sun/Mon/Tue…) marks the start of each
// day's block; entries span multiple rows under the same day.
// Two side-by-side week blocks (common in the standard template)
// are both parsed.
// ---------------------------------------------------------------

function tryParseWeeklyTableFormat(rows) {
  const DAY_NAMES = new Set(['sun','mon','tue','wed','thu','fri','sat'])

  // Find header row (within first 10 rows): must contain 'day' AND 'date'
  let headerRowIdx = -1
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const lower = rows[i].map(c => String(c || '').toLowerCase().trim())
    if (lower.includes('day') && lower.includes('date')) {
      headerRowIdx = i
      break
    }
  }
  if (headerRowIdx === -1) return []

  const hdrs = rows[headerRowIdx].map(c => String(c || '').toLowerCase().trim())

  // Locate every "block" that starts with a 'day' + 'date' column pair
  const blocks = []
  for (let c = 0; c < hdrs.length; c++) {
    if (hdrs[c] !== 'day') continue
    if (c + 1 >= hdrs.length || hdrs[c + 1] !== 'date') continue

    // Search rightward for related columns (within 10 cols of this Day col)
    const findNear = (keyword) => {
      for (let k = c; k < Math.min(hdrs.length, c + 10); k++) {
        if (hdrs[k] === keyword || hdrs[k].startsWith(keyword)) return k
      }
      return -1
    }

    const timeCol    = findNear('time')
    if (timeCol === -1) continue // this block has no time column — skip

    blocks.push({
      dayCol:     c,
      dateCol:    c + 1,
      projectCol: findNear('project'),
      stageCol:   findNear('stage'),
      timeCol,
      descCol:    findNear('description') !== -1 ? findNear('description') : findNear('desc'),
    })
  }

  if (blocks.length === 0) return []

  // dayMap: ISO date → entries[]
  const dayMap = new Map()

  for (const block of blocks) {
    let currentDate = null

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i]
      const dayCell = String(row[block.dayCol] || '').trim()

      // Stop at footer row (e.g. "TOTAL HOURS")
      if (/^total/i.test(dayCell)) break

      // New day: Day cell is a day-of-week abbreviation + adjacent Date cell is non-empty
      const dayKey = dayCell.toLowerCase().slice(0, 3)
      if (DAY_NAMES.has(dayKey)) {
        const rawDate = row[block.dateCol]
        const d = rawDate ? normalizeDate(rawDate) : null
        if (d) currentDate = d
      }

      if (!currentDate) continue

      // Entry: Time cell must be a non-empty string (not a Date object from Excel)
      const rawTime = block.timeCol !== -1 ? row[block.timeCol] : null
      if (!rawTime || rawTime instanceof Date) continue
      const timeStr = String(rawTime).trim()
      if (!timeStr) continue

      const parsed = parseTimeRange(timeStr)
      if (!parsed) continue

      const projectStr = block.projectCol !== -1 ? String(row[block.projectCol] || '').trim() : ''
      const stageStr   = block.stageCol   !== -1 ? String(row[block.stageCol]   || '').trim() : ''
      const descStr    = block.descCol    !== -1 ? String(row[block.descCol]    || '').trim() : ''

      // Combine Stage + Description into task ("SD — Joinery details")
      let task = null
      if (stageStr && descStr) task = `${stageStr} — ${descStr}`
      else if (stageStr)       task = stageStr
      else if (descStr)        task = descStr

      if (!dayMap.has(currentDate)) dayMap.set(currentDate, [])
      dayMap.get(currentDate).push({
        time_from:     parsed.from,
        time_to:       parsed.to,
        hours_decimal: parsed.hours,
        project_name:  projectStr || null,
        task,
      })
    }
  }

  // Sort by date, exclude days with no entries
  return [...dayMap.entries()]
    .filter(([, entries]) => entries.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({ date, entries }))
}

// ---------------------------------------------------------------
// FORMAT 2 — Section-based (explicit "Date:" label rows)
//
// Each day starts with a row containing "Date: 2024-06-03" or
// a two-cell "Date" | "2024-06-03" pattern.  Entries follow until
// the next "Date:" marker.
// ---------------------------------------------------------------

function tryParseSectionFormat(rows) {
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
    const end   = m + 1 < markers.length ? markers[m + 1].rowIdx : rows.length
    const entries = parseSectionEntries(rows.slice(start, end))
    if (entries.length > 0) days.push({ date: markers[m].date, entries })
  }
  return days
}

// Parse entries within a scoped section of rows (already cut to one day)
function parseSectionEntries(rows) {
  const TIME_KW    = ['time', 'hours', 'from', 'duration']
  const PROJECT_KW = ['project', 'work', 'client']
  const TASK_KW    = ['task', 'description', 'detail', 'activity']

  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map(c => String(c).toLowerCase().trim())
    const hasTime    = lower.some(h => TIME_KW.some(k => h.includes(k)))
    const hasProject = lower.some(h => PROJECT_KW.some(k => h.includes(k)))
    if (hasTime && hasProject) { headerRowIdx = i; break }
  }
  if (headerRowIdx === -1) return []

  const hdrs       = rows[headerRowIdx].map(c => String(c).toLowerCase().trim())
  const timeIdx    = findColIdx(hdrs, TIME_KW)
  const projectIdx = findColIdx(hdrs, PROJECT_KW)
  const taskIdx    = findColIdx(hdrs, TASK_KW)

  const entries = []
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row.some(c => c !== '' && c !== null && c !== undefined)) continue

    const rawTime    = timeIdx    !== -1 ? String(row[timeIdx]    || '').trim() : ''
    const rawProject = projectIdx !== -1 ? String(row[projectIdx] || '').trim() : ''
    const rawTask    = taskIdx    !== -1 ? String(row[taskIdx]    || '').trim() : ''

    if (!rawTime && !rawProject) continue

    const parsed = parseTimeRange(rawTime)
    entries.push({
      time_from:     parsed?.from    ?? null,
      time_to:       parsed?.to      ?? null,
      hours_decimal: parsed?.hours   ?? null,
      project_name:  rawProject || null,
      task:          rawTask    || null,
    })
  }
  return entries
}

// ---------------------------------------------------------------
// FORMAT 3 — Legacy single-day fallback
//
// Searches the first ~5 rows for any date indicator, then finds
// a single header + entry block.  Handles raw Date objects and
// Excel serial numbers.
// ---------------------------------------------------------------

function parseLegacySingleDay(rows) {
  const TIME_KW    = ['time', 'hours', 'from', 'duration']
  const PROJECT_KW = ['project', 'work', 'client']

  let date = null
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
          if (d) date = `${d.y}-${pad(d.m)}-${pad(d.d)}`; break
        }
        if (!date && isDateString(cellStr)) date = normalizeDate(cellStr)
      }
    }

    if (headerRowIdx === -1) {
      const lower = row.map(c => String(c).toLowerCase().trim())
      const hasTime    = lower.some(h => TIME_KW.some(k => h.includes(k)))
      const hasProject = lower.some(h => PROJECT_KW.some(k => h.includes(k)))
      if (hasTime && hasProject) headerRowIdx = i
    }

    if (date && headerRowIdx !== -1) break
  }

  const entries = headerRowIdx !== -1 ? parseSectionEntries(rows.slice(headerRowIdx)) : []
  return { date, entries }
}

// ---------------------------------------------------------------
// SHARED PARSING UTILITIES
// ---------------------------------------------------------------

function findColIdx(headers, keywords) {
  for (const kw of keywords) {
    const idx = headers.findIndex(h => h.includes(kw))
    if (idx !== -1) return idx
  }
  return -1
}

function parseTimeRange(raw) {
  if (!raw || raw instanceof Date) return null

  let s = String(raw).trim()
    .replace(/\s+to\s+/gi, '~')
    .replace(/\s*[-–—]\s*/g, '~')

  const parts = s.split('~')
  if (parts.length < 2) return null

  const from = parseTimeDecimal(parts[0].trim())
  const to   = parseTimeDecimal(parts[parts.length - 1].trim())
  if (from === null || to === null) return null

  let hours = to - from
  if (hours < 0) hours += 24 // overnight shift

  return {
    from:  decimalToHHMM(from),
    to:    decimalToHHMM(to),
    hours: Math.round(hours * 100) / 100,
  }
}

function parseTimeDecimal(s) {
  const clean = s.trim().replace(/\s+/g, ' ')

  // 12-hour: "2:30 PM", "2PM", "2:30pm", "02:30 AM"
  const m12 = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (m12) {
    let h = parseInt(m12[1], 10)
    const m = m12[2] ? parseInt(m12[2], 10) : 0
    const mer = m12[3].toLowerCase()
    if (mer === 'pm' && h !== 12) h += 12
    if (mer === 'am' && h === 12) h = 0
    return h + m / 60
  }

  // HH:MM:SS — seconds present, ignore them ("1:30:00", "13:30:00")
  const m24s = clean.match(/^(\d{1,2}):(\d{2}):\d{2}$/)
  if (m24s) return parseInt(m24s[1], 10) + parseInt(m24s[2], 10) / 60

  // HH:MM — standard 24-hour ("14:30", "09:00")
  const m24 = clean.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1], 10) + parseInt(m24[2], 10) / 60

  // Bare hour integer ("14", "9")
  const mH = clean.match(/^(\d{1,2})$/)
  if (mH) return parseInt(mH[1], 10)

  // Excel fractional day (e.g. 0.375 = 09:00)
  const n = parseFloat(clean)
  if (!isNaN(n) && n >= 0 && n < 1) return n * 24

  return null
}

function decimalToHHMM(dec) {
  const h = Math.floor(dec)
  const m = Math.round((dec - h) * 60)
  return `${pad(h)}:${pad(m)}`
}

function normalizeDate(val) {
  if (!val) return null
  if (val instanceof Date) return toISODate(val)
  const s = String(val).trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  // DD/MM/YYYY or MM/DD/YYYY
  const slashMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/)
  if (slashMatch) {
    const a = parseInt(slashMatch[1], 10)
    const b = parseInt(slashMatch[2], 10)
    const y = slashMatch[3]
    if (a > 12) return `${y}-${pad(b)}-${pad(a)}`
    return `${y}-${pad(a)}-${pad(b)}`
  }

  const d = new Date(s)
  if (!isNaN(d.getTime())) return toISODate(d)
  return null
}

function isDateString(s) {
  if (s.length < 6) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true
  if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}$/.test(s)) return true
  return false
}

function toISODate(d) {
  // Excel Date objects from timezone-aware workbooks (e.g. UAE UTC+4) arrive with
  // a UTC time near-but-before midnight (e.g. 19:59 UTC = 23:59 local).
  // Adding 12 hours before extracting the UTC date reliably recovers the intended
  // calendar date regardless of where the server is running.
  const shifted = new Date(d.getTime() + 12 * 3600 * 1000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

function pad(n) { return String(n).padStart(2, '0') }

function round2(n) { return Math.round(n * 100) / 100 }
