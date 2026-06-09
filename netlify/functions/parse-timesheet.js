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
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
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

    // ── Upload raw file to Supabase storage (once for all days) ─
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
// MULTI-DAY PARSER
// ---------------------------------------------------------------

function parseSheetMultiDay(rows) {
  // Scan every row for explicit "Date:" labels — these are day-section dividers.
  const dateMarkers = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    for (let j = 0; j < row.length; j++) {
      const cell = row[j]
      const cellStr = String(cell || '').trim()
      let d = null

      // "Date" or "Date:" in cell j, actual date value in adjacent cell j+1
      if (/^date\s*:?\s*$/i.test(cellStr) && j + 1 < row.length) {
        d = normalizeDate(row[j + 1])
      }
      // "Date: 2024-01-15" combined in one cell
      else if (/^date\s*:\s*.+/i.test(cellStr)) {
        d = normalizeDate(cellStr.replace(/^date\s*:\s*/i, ''))
      }

      if (d) {
        dateMarkers.push({ rowIdx: i, date: d })
        break
      }
    }
  }

  // No explicit "Date:" labels — fall back to legacy single-day logic
  // (handles raw Date objects and Excel serial numbers in the first few rows)
  if (dateMarkers.length === 0) {
    const result = parseLegacySingleDay(rows)
    if (result.date && result.entries.length > 0) {
      return [{ date: result.date, entries: result.entries }]
    }
    return []
  }

  // Split rows into per-day sections and parse each
  const days = []
  for (let m = 0; m < dateMarkers.length; m++) {
    const start = dateMarkers[m].rowIdx
    const end = (m + 1 < dateMarkers.length) ? dateMarkers[m + 1].rowIdx : rows.length
    const sectionRows = rows.slice(start, end)
    const entries = parseSectionEntries(sectionRows)
    if (entries.length > 0) {
      days.push({ date: dateMarkers[m].date, entries })
    }
  }

  return days
}

// Parse entries within a single day's section (rows already scoped to that day)
function parseSectionEntries(rows) {
  const timeHeaderKeywords    = ['time', 'hours', 'from', 'duration']
  const projectHeaderKeywords = ['project', 'work', 'client']
  const taskHeaderKeywords    = ['task', 'description', 'detail', 'activity']

  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map(c => String(c).toLowerCase().trim())
    const hasTime    = lower.some(h => timeHeaderKeywords.some(k => h.includes(k)))
    const hasProject = lower.some(h => projectHeaderKeywords.some(k => h.includes(k)))
    if (hasTime && hasProject) { headerRowIdx = i; break }
  }

  if (headerRowIdx === -1) return []

  const hdrs       = rows[headerRowIdx].map(c => String(c).toLowerCase().trim())
  const timeIdx    = findColIdx(hdrs, timeHeaderKeywords)
  const projectIdx = findColIdx(hdrs, projectHeaderKeywords)
  const taskIdx    = findColIdx(hdrs, taskHeaderKeywords)

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

// Legacy single-day parser (searches first ~5 rows for date, handles raw Date objects)
function parseLegacySingleDay(rows) {
  let date = null
  let headerRowIdx = -1
  const timeHeaderKeywords    = ['time', 'hours', 'from', 'duration']
  const projectHeaderKeywords = ['project', 'work', 'client']

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
          date = toISODate(cell); break
        }
        if (!date && typeof cell === 'number' && cell > 40000 && cell < 60000) {
          const d = XLSX.SSF.parse_date_code(cell)
          if (d) date = `${d.y}-${pad(d.m)}-${pad(d.d)}`; break
        }
        if (!date && isDateString(cellStr)) {
          date = normalizeDate(cellStr)
        }
      }
    }

    if (headerRowIdx === -1) {
      const lower = row.map(c => String(c).toLowerCase().trim())
      const hasTime    = lower.some(h => timeHeaderKeywords.some(k => h.includes(k)))
      const hasProject = lower.some(h => projectHeaderKeywords.some(k => h.includes(k)))
      if (hasTime && hasProject) headerRowIdx = i
    }

    if (date && headerRowIdx !== -1) break
  }

  const entries = headerRowIdx !== -1 ? parseSectionEntries(rows.slice(headerRowIdx)) : []
  return { date, entries }
}

// ---------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------

function findColIdx(headers, keywords) {
  for (const kw of keywords) {
    const idx = headers.findIndex(h => h.includes(kw))
    if (idx !== -1) return idx
  }
  return -1
}

function parseTimeRange(raw) {
  if (!raw) return null

  let s = raw.trim()
    .replace(/\s+to\s+/gi, '~')
    .replace(/\s*[-–—]\s*/g, '~')

  const parts = s.split('~')
  if (parts.length < 2) return null

  const from = parseTimeDecimal(parts[0].trim())
  const to   = parseTimeDecimal(parts[parts.length - 1].trim())
  if (from === null || to === null) return null

  let hours = to - from
  if (hours < 0) hours += 24

  return {
    from:  decimalToHHMM(from),
    to:    decimalToHHMM(to),
    hours: Math.round(hours * 100) / 100,
  }
}

function parseTimeDecimal(s) {
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

  // 24-hour: "14:30", "09:00"
  const m24 = clean.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1], 10) + parseInt(m24[2], 10) / 60

  // Bare hour: "14", "9"
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function pad(n) { return String(n).padStart(2, '0') }

function round2(n) { return Math.round(n * 100) / 100 }
