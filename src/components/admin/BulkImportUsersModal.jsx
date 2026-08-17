// Bulk employee import: CSV in, accounts out. Mirrors UploadPage's own
// dry-run -> preview -> confirm shape for the XLSX timesheet importer —
// same reasoning applies here, doubly so: this creates accounts, so
// nothing gets written until IT has seen exactly what will happen.
//
// Self-contained (own modal shell, own small UI primitives) rather than
// reaching into AdminPage.jsx's internals — those aren't exported, and
// this is a big enough, independent enough feature to earn its own file
// (same call TimesheetCompliance.jsx made earlier).

import { useRef, useState } from 'react'
import {
  X, Upload, Download, ShieldCheck, AlertTriangle, CheckCircle2,
  XCircle, Copy, ArrowLeft,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { parseCSV, toCSV, downloadCSV } from '../../lib/csv'

const TEMPLATE_COLUMNS = ['email', 'fullName', 'office', 'roles', 'managerEmail', 'joiningDate', 'discipline']

const TEMPLATE_SAMPLE = [
  {
    email: 'jane.smith@example.com', fullName: 'Jane Smith', office: 'Dubai',
    roles: 'employee', managerEmail: 'manager@example.com', joiningDate: '2026-01-15', discipline: 'Architecture',
  },
]

async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    let message = error.message
    if (error.context?.json) {
      try { message = (await error.context.json())?.error || message } catch { /* not JSON */ }
    }
    throw new Error(message)
  }
  return data
}

function Spinner() {
  return <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
}

export default function BulkImportUsersModal({ onClose, onImported }) {
  // 'pick' -> 'preview' -> 'importing' -> 'results'
  const [step, setStep] = useState('pick')
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState([])          // raw parsed CSV rows
  const [preview, setPreview] = useState(null)   // dry-run response
  const [results, setResults] = useState(null)   // confirm response
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef(null)

  function downloadTemplate() {
    downloadCSV('employee-import-template.csv', toCSV(TEMPLATE_SAMPLE, TEMPLATE_COLUMNS))
  }

  function handleFile(file) {
    if (!file) return
    setError('')
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseCSV(String(reader.result))
        if (parsed.length === 0) { setError('That file has no data rows.'); return }
        setRows(parsed)
      } catch {
        setError('Could not parse that file as CSV.')
      }
    }
    reader.onerror = () => setError('Could not read that file.')
    reader.readAsText(file)
  }

  function toApiRows(parsedRows) {
    return parsedRows.map((r) => ({
      email: r.email, fullName: r.fullName, office: r.office,
      roles: r.roles, managerEmail: r.managerEmail, joiningDate: r.joiningDate, discipline: r.discipline,
    }))
  }

  async function runDryRun() {
    setBusy(true)
    setError('')
    try {
      const data = await invoke('bulk-import-users', { rows: toApiRows(rows), dryRun: true })
      setPreview(data)
      setStep('preview')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function runConfirm() {
    setStep('importing')
    setError('')
    try {
      const data = await invoke('bulk-import-users', { rows: toApiRows(rows), dryRun: false })
      setResults(data)
      setStep('results')
      if (data.created > 0) onImported?.()
    } catch (err) {
      setError(err.message)
      setStep('preview')
    }
  }

  function downloadResults() {
    const created = results.results.filter((r) => r.status === 'created')
    downloadCSV('employee-import-results.csv', toCSV(created, ['email', 'tempPassword']))
  }

  async function copyRow(text) {
    try { await navigator.clipboard.writeText(text) } catch { /* clipboard unavailable, non-fatal */ }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full max-w-3xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-ae7-red" />
            <h3 className="font-semibold text-sm">Bulk import employees</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
              <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {step === 'pick' && (
            <>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Upload a CSV of new employees. Each account gets a system-generated
                temporary password — nobody chooses or emails it, and it's shown to
                you exactly once after import, so save it somewhere secure right away.
              </p>

              <button onClick={downloadTemplate} className="btn-secondary text-sm">
                <Download size={14} /> Download CSV template
              </button>

              <div className="text-xs text-gray-400 space-y-1 bg-gray-50 dark:bg-gray-800/50 rounded-xl px-4 py-3">
                <p><strong>email</strong>, <strong>fullName</strong>, <strong>office</strong> — required.</p>
                <p><strong>roles</strong> — optional, semicolon-separated (e.g. <code>employee;manager</code>). Defaults to <code>employee</code>.</p>
                <p><strong>managerEmail</strong> — optional, must already be a manager or C-Suite user.</p>
                <p><strong>joiningDate</strong> — optional, <code>YYYY-MM-DD</code>.</p>
                <p><strong>discipline</strong> — optional, must match an existing discipline name.</p>
              </div>

              <div>
                <label className="label">CSV file</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  className="input text-sm"
                />
                {fileName && rows.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1.5">{fileName} — {rows.length} row{rows.length !== 1 ? 's' : ''} parsed.</p>
                )}
              </div>
            </>
          )}

          {step === 'preview' && preview && (
            <>
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                  <CheckCircle2 size={15} /> {preview.validCount} ready
                </span>
                {preview.invalidCount > 0 && (
                  <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-medium">
                    <XCircle size={15} /> {preview.invalidCount} need fixing
                  </span>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                      <th className="px-3 py-2 font-medium">Row</th>
                      <th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {preview.rows.map((r) => (
                      <tr key={r.row}>
                        <td className="px-3 py-2 text-gray-400">{r.row}</td>
                        <td className="px-3 py-2 truncate max-w-[200px]">{r.email || <span className="italic text-gray-400">(blank)</span>}</td>
                        <td className="px-3 py-2">
                          {r.valid ? (
                            <span className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">Ready</span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400 text-xs">{r.errors.join(' ')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-gray-400">
                Rows that need fixing will be skipped — nothing invalid gets created.
                Fix your CSV and re-upload, or continue with just the {preview.validCount} ready row{preview.validCount !== 1 ? 's' : ''}.
              </p>
            </>
          )}

          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Spinner />
              <p className="text-sm text-gray-500 dark:text-gray-400">Creating accounts…</p>
            </div>
          )}

          {step === 'results' && results && (
            <>
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                  <CheckCircle2 size={15} /> {results.created} created
                </span>
                {results.skipped > 0 && (
                  <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium">
                    <AlertTriangle size={15} /> {results.skipped} skipped
                  </span>
                )}
                {results.failed > 0 && (
                  <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-medium">
                    <XCircle size={15} /> {results.failed} failed
                  </span>
                )}
              </div>

              {results.created > 0 && (
                <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-xl px-3 py-2">
                  <ShieldCheck size={15} className="flex-shrink-0 mt-0.5" />
                  These passwords are shown once and cannot be retrieved again. Download or copy them now.
                </div>
              )}

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                      <th className="px-3 py-2 font-medium">Row</th>
                      <th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {results.results.map((r) => (
                      <tr key={r.row}>
                        <td className="px-3 py-2 text-gray-400">{r.row}</td>
                        <td className="px-3 py-2 truncate max-w-[180px]">{r.email}</td>
                        <td className="px-3 py-2">
                          {r.status === 'created' ? (
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded select-all">{r.tempPassword}</code>
                              <button onClick={() => copyRow(`${r.email}\t${r.tempPassword}`)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Copy email + password">
                                <Copy size={13} />
                              </button>
                            </div>
                          ) : (
                            <span className={clsx('text-xs', r.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')}>
                              {r.reason}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
          {step === 'pick' && (
            <>
              <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
              <button onClick={runDryRun} disabled={busy || rows.length === 0} className="btn-primary flex-1">
                {busy ? <Spinner /> : 'Validate'}
              </button>
            </>
          )}
          {step === 'preview' && (
            <>
              <button onClick={() => setStep('pick')} className="btn-secondary flex-1">
                <ArrowLeft size={14} /> Back
              </button>
              <button onClick={runConfirm} disabled={preview.validCount === 0} className="btn-primary flex-1">
                Import {preview.validCount} account{preview.validCount !== 1 ? 's' : ''}
              </button>
            </>
          )}
          {step === 'results' && (
            <>
              {results.created > 0 && (
                <button onClick={downloadResults} className="btn-secondary flex-1">
                  <Download size={14} /> Download passwords (CSV)
                </button>
              )}
              <button onClick={onClose} className="btn-primary flex-1">Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
