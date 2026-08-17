// Minimal RFC 4180 CSV parse/serialize — no dependency. Deliberately not
// using the `xlsx` library here even though it's already installed: it
// carries an unfixed high-severity advisory (prototype pollution + ReDoS),
// and bulk user import is the highest-privilege operation in the app to
// be feeding it untrusted input. CSV needs no such library at all.

// Handles quoted fields (commas/newlines/quotes inside "..."), doubled
// "" as an escaped quote, and both \r\n and \n line endings. Returns an
// array of objects keyed by the header row.
export function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  // Normalize line endings up front so the state machine below only
  // needs to reason about \n.
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  function endField() { row.push(field); field = '' }
  function endRow() { endField(); rows.push(row); row = [] }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } // escaped quote
        else inQuotes = false
      } else {
        field += c
      }
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { endField(); continue }
    if (c === '\n') { endRow(); continue }
    field += c
  }
  // Trailing field/row (file may or may not end with a newline).
  if (field !== '' || row.length > 0) endRow()

  // Drop fully-blank trailing rows (a common artifact of "Save As CSV"
  // from Excel, which often appends one).
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop()

  if (rows.length === 0) return []
  const headers = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
}

// Quotes a field only when necessary (contains a comma, quote, or
// newline), matching how Excel/Sheets themselves write CSV — keeps the
// output readable rather than quoting every cell unconditionally.
function csvField(value) {
  const s = value == null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// rows: array of objects. columns: ordered array of keys to emit (also
// becomes the header row) — explicit rather than inferred from the first
// row's keys, so column order is stable even if some rows are missing a
// field.
export function toCSV(rows, columns) {
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((col) => csvField(row[col])).join(','))
  }
  return lines.join('\r\n')
}

// Triggers a browser download of `content` as `filename` — used for both
// the import template and the results (temp passwords), neither of which
// should round-trip through a server.
export function downloadCSV(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
