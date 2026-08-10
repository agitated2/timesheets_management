// HTML/plain-text builder for the daily timesheet reminder email.
// Table-based markup with fully inline CSS — Outlook (the primary client
// here, given delivery is via M365/Graph) ignores <style> blocks entirely.
//
// Deno port of netlify/lib/reminder-templates.js (now retired) — logic is
// byte-for-byte the same, only `export` replaces `module.exports`.

export interface ReportRow {
  employee_id: string
  full_name: string | null
  email: string
  office_id: string
  office_name: string
  business_date: string  // 'YYYY-MM-DD' from a Postgres DATE column
  state: 'missing' | 'late'
}

const STATE_LABEL: Record<string, string> = { missing: 'Missing', late: 'Late' }
const STATE_COLOR: Record<string, string> = { missing: '#dc2626', late: '#d97706' }

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string))
}

// business_date arrives as a plain 'YYYY-MM-DD' string from a Postgres
// DATE column — format it without routing through a Date object's
// local-timezone parsing, which is exactly the class of bug this whole
// feature exists to avoid.
function fmtDate(d: string): string {
  const [y, m, day] = d.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(day)} ${months[Number(m) - 1]} ${y}`
}

function rowHtml(row: ReportRow, showEmployee: boolean): string {
  const color = STATE_COLOR[row.state] || '#6b7280'
  const label = STATE_LABEL[row.state] || row.state
  const cell = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;'
  return `<tr>` +
    (showEmployee ? `<td style="${cell}">${escapeHtml(row.full_name || row.email)}</td>` : '') +
    `<td style="${cell}">${escapeHtml(row.office_name)}</td>` +
    `<td style="${cell}">${fmtDate(row.business_date)}</td>` +
    `<td style="${cell}color:${color};font-weight:600;">${label}</td>` +
    `</tr>`
}

function sectionHtml(title: string, rows: ReportRow[], showEmployee: boolean): string {
  if (!rows.length) return ''
  const th = 'text-align:left;padding:6px 10px;font-size:12px;color:#6b7280;border-bottom:2px solid #e5e7eb;'
  return `
    <h3 style="font-size:15px;margin:24px 0 8px;color:#111827;">${escapeHtml(title)}</h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        ${showEmployee ? `<th style="${th}">Employee</th>` : ''}
        <th style="${th}">Office</th>
        <th style="${th}">Date</th>
        <th style="${th}">Status</th>
      </tr></thead>
      <tbody>${rows.map(r => rowHtml(r, showEmployee)).join('')}</tbody>
    </table>`
}

function sectionText(title: string, rows: ReportRow[], showEmployee: boolean): string {
  if (!rows.length) return ''
  const lines = rows.map(r => {
    const who = showEmployee ? `${r.full_name || r.email} — ` : ''
    return `  - ${who}${r.office_name} — ${fmtDate(r.business_date)} — ${STATE_LABEL[r.state] || r.state}`
  })
  return `\n${title}\n${lines.join('\n')}\n`
}

export interface BuildReminderEmailArgs {
  recipientName: string | null
  uploadUrl: string
  ownRows?: ReportRow[]
  teamRows?: ReportRow[]
  officeRows?: ReportRow[]
}

export interface ReminderEmail {
  subject: string
  html: string
  text: string
}

// ownRows/teamRows/officeRows: rows from timesheet_status_report, each
// carrying its own office + date, so sections spanning multiple offices
// (an HR digest, or a manager whose reports span offices) stay
// unambiguous without a separate per-office sub-table.
export function buildReminderEmail({
  recipientName, uploadUrl, ownRows = [], teamRows = [], officeRows = [],
}: BuildReminderEmailArgs): ReminderEmail {
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,'

  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;color:#111827;max-width:640px;">
    <p style="font-size:14px;">${escapeHtml(greeting)}</p>
    <p style="font-size:14px;">Here is today's timesheet status summary.</p>
    ${sectionHtml('Your outstanding timesheets', ownRows, false)}
    ${sectionHtml('Your team', teamRows, true)}
    ${sectionHtml('Your offices', officeRows, true)}
    ${ownRows.length ? `<p style="margin-top:24px;"><a href="${escapeHtml(uploadUrl)}" style="background:#C41230;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;display:inline-block;">Submit your timesheet</a></p>` : ''}
    <p style="font-size:12px;color:#9ca3af;margin-top:32px;">This is an automated reminder. "Late" means submitted after your office's daily deadline; "Missing" means not yet submitted.</p>
  </div>`

  const text = [
    greeting,
    '',
    "Here is today's timesheet status summary.",
    sectionText('Your outstanding timesheets', ownRows, false),
    sectionText('Your team', teamRows, true),
    sectionText('Your offices', officeRows, true),
    ownRows.length ? `\nSubmit your timesheet: ${uploadUrl}\n` : '',
    '\n"Late" means submitted after your office\'s daily deadline; "Missing" means not yet submitted.',
  ].filter(Boolean).join('\n')

  const subjectParts: string[] = []
  if (ownRows.length) subjectParts.push(`${ownRows.length} of yours`)
  if (teamRows.length) subjectParts.push(`${teamRows.length} on your team`)
  if (officeRows.length) subjectParts.push(`${officeRows.length} in your offices`)
  const subject = `Timesheet reminder — ${subjectParts.join(', ')}`

  return { subject, html, text }
}
