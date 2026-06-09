import { useCallback, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  Upload, FileSpreadsheet, CheckCircle, AlertCircle, X,
  UserX, Calendar, Clock, ChevronDown, ChevronUp, AlertTriangle, XCircle,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ── Manager gate ─────────────────────────────────────────────────
function ManagerGate() {
  return (
    <div className="max-w-lg mx-auto">
      <div className="card p-10 text-center space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center mx-auto">
          <UserX size={28} className="text-amber-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-1">Line manager required</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You need to assign a line manager before you can upload timesheets.
            Your manager will receive and review your submissions.
          </p>
        </div>
        <Link to="/settings" className="btn-primary mx-auto">
          Go to Settings to assign a manager
        </Link>
      </div>
    </div>
  )
}

// ── Success screen ───────────────────────────────────────────────
function SuccessScreen({ result, onReset, navigate }) {
  const { days, totalDays, totalHours } = result
  const [expandedDay, setExpandedDay] = useState(null)
  const isMulti = totalDays > 1

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="card p-8 text-center">
        <CheckCircle size={48} className="text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-bold mb-1">
          {isMulti ? `${totalDays} timesheets submitted!` : 'Timesheet submitted!'}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Your manager has been notified and will review {isMulti ? 'them' : 'it'} shortly.
        </p>

        {/* Totals */}
        <div className="flex items-center justify-center gap-6 bg-gray-50 dark:bg-gray-800 rounded-xl p-4 mb-5">
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalDays}</p>
            <p className="text-xs text-gray-400">{totalDays === 1 ? 'day' : 'days'}</p>
          </div>
          <div className="w-px h-10 bg-gray-200 dark:bg-gray-700" />
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalHours}</p>
            <p className="text-xs text-gray-400">total hours</p>
          </div>
        </div>

        {/* Per-day breakdown */}
        <div className="space-y-2 text-left mb-6">
          {days.map((day, di) => {
            const isOpen = expandedDay === di
            const dateLabel = format(parseISO(day.date), isMulti ? 'EEE, MMM d, yyyy' : 'MMMM d, yyyy')
            return (
              <div key={day.date} className="bg-gray-50 dark:bg-gray-800 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedDay(isOpen ? null : di)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-blue-500 flex-shrink-0" />
                    <span className="text-sm font-medium">{dateLabel}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">{day.hours}h · {day.entries.length} {day.entries.length === 1 ? 'entry' : 'entries'}</span>
                    {isOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700/50">
                    {day.entries.map((e, i) => (
                      <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div className="min-w-0">
                          <span className="font-medium">{e.project_name || '—'}</span>
                          {e.task && <span className="text-gray-400 ml-2 text-xs">· {e.task}</span>}
                        </div>
                        <span className="text-gray-400 text-xs flex-shrink-0 ml-3">
                          {e.time_from} – {e.time_to} ({e.hours_decimal}h)
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex gap-3">
          <button onClick={onReset} className="btn-secondary flex-1">Upload another</button>
          <button onClick={() => navigate('/history')} className="btn-primary flex-1">View history</button>
        </div>
      </div>
    </div>
  )
}

// ── Confirmation screen ──────────────────────────────────────────
function ConfirmationScreen({ preview, onConfirm, onCancel, confirming }) {
  const { days, totalDays, totalHours, discrepancies = [], hasDiscrepancies = false } = preview
  const isMulti   = totalDays > 1
  const dateRange = isMulti
    ? `${format(parseISO(days[0].date), 'MMM d')} – ${format(parseISO(days[days.length - 1].date), 'MMM d, yyyy')}`
    : format(parseISO(days[0].date), 'MMMM d, yyyy')

  return (
    <div className="max-w-lg mx-auto space-y-5">
      <div className="card p-6 space-y-5">
        <div className="text-center">
          <div className={clsx(
            'w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3',
            hasDiscrepancies
              ? 'bg-red-50 dark:bg-red-950/30'
              : 'bg-gray-50 dark:bg-gray-800'
          )}>
            {hasDiscrepancies
              ? <XCircle size={22} className="text-red-500" />
              : <Calendar size={22} className="text-ae7-red" />
            }
          </div>
          <h2 className="text-lg font-semibold">
            {hasDiscrepancies ? 'Discrepancies found' : 'Confirm submission'}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {hasDiscrepancies
              ? 'Your file has time mismatches between the Time and Total Hours columns.'
              : <>You are uploading {isMulti
                  ? <strong>timesheets for {totalDays} days</strong>
                  : <strong>a timesheet for 1 day</strong>
                }.</>
            }
          </p>
          {!hasDiscrepancies && isMulti && (
            <p className="text-xs text-gray-400 mt-0.5">{dateRange}</p>
          )}
        </div>

        {/* ── Discrepancy list ─────────────────────────────────── */}
        {hasDiscrepancies && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {discrepancies.length} issue{discrepancies.length !== 1 ? 's' : ''} to fix
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {discrepancies.map((d, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-800 dark:text-gray-200 truncate">
                        {d.project} · {format(parseISO(d.date), 'EEE MMM d')}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        Time range <strong>{d.timeRange}</strong> = <strong>{d.calculatedHours}h</strong>
                        {' '}but Total Hours column shows <strong>{d.statedHours}h</strong>
                      </p>
                    </div>
                    <span className="text-xs font-mono bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-md flex-shrink-0 whitespace-nowrap">
                      Row {d.rowNumber}
                    </span>
                  </div>
                  {Math.abs(d.calculatedHours - d.statedHours) >= 10 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 flex items-center gap-1">
                      <AlertTriangle size={11} className="flex-shrink-0" />
                      Large gap — possible AM/PM confusion (e.g. 12:00 AM instead of 12:00 PM)?
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Please fix these in your Excel file and re-upload. Row numbers match the Excel row display.
            </p>
          </div>
        )}

        {/* ── Day-by-day table (only shown when no discrepancies) ─ */}
        {!hasDiscrepancies && (
          <>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="grid grid-cols-3 text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <span>Date</span>
                <span className="text-center">Entries</span>
                <span className="text-right">Hours</span>
              </div>
              {days.map(d => (
                <div key={d.date} className="grid grid-cols-3 px-4 py-2.5 text-sm border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <span className="font-medium">{format(parseISO(d.date), 'EEE, MMM d')}</span>
                  <span className="text-center text-gray-500">{d.entriesCount}</span>
                  <span className="text-right text-gray-700 dark:text-gray-300">{d.hours}h</span>
                </div>
              ))}
              <div className="grid grid-cols-3 px-4 py-2.5 text-sm font-semibold bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
                <span>Total</span>
                <span className="text-center text-gray-500">{days.reduce((s, d) => s + d.entriesCount, 0)}</span>
                <span className="text-right text-ae7-red">{totalHours}h</span>
              </div>
            </div>
            <p className="text-xs text-gray-400 text-center">
              {isMulti
                ? 'This will create one timesheet submission per day. Each day is reviewed independently.'
                : 'Your manager will be notified to review this timesheet.'}
            </p>
          </>
        )}

        <div className="flex gap-3">
          <button onClick={onCancel} disabled={confirming} className="btn-secondary flex-1">
            {hasDiscrepancies ? 'Back' : 'Cancel'}
          </button>
          {hasDiscrepancies ? (
            <div className="flex-1 flex items-center justify-center px-4 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-800 text-xs text-gray-400 font-medium text-center">
              Fix file to continue
            </div>
          ) : (
            <button onClick={onConfirm} disabled={confirming} className="btn-primary flex-1">
              {confirming
                ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Submitting…</>
                : <><CheckCircle size={15} /> Confirm &amp; Submit</>
              }
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────
export default function UploadPage() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()

  if (!profile?.manager_id) return <ManagerGate />

  const [file, setFile]           = useState(null)
  const [dragging, setDragging]   = useState(false)
  // state: 'idle' | 'previewing' | 'confirming' | 'uploading' | 'success' | 'error'
  const [state, setState]         = useState('idle')
  const [previewData, setPreview] = useState(null)  // dry-run response
  const [result, setResult]       = useState(null)  // final insert response
  const [errorMsg, setErrorMsg]   = useState('')

  const accept = '.xlsx,.xls,.xlsm'

  function pickFile(f) {
    if (!f) return
    const ext = f.name.split('.').pop().toLowerCase()
    if (!['xlsx', 'xls', 'xlsm'].includes(ext)) {
      setErrorMsg('Please select an Excel file (.xlsx, .xls, or .xlsm).')
      return
    }
    if (f.size > 10 * 1024 * 1024) {
      setErrorMsg('File must be under 10 MB.')
      return
    }
    setFile(f)
    setErrorMsg('')
    setState('idle')
  }

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    pickFile(e.dataTransfer.files[0])
  }, [])

  async function callApi(isDryRun) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Not authenticated')
    const base64 = await fileToBase64(file)
    const res = await fetch('/.netlify/functions/parse-timesheet', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ file: base64, fileName: file.name, dryRun: isDryRun }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Upload failed')
    return data
  }

  // Step 1: dry-run to get preview
  async function handlePreview() {
    if (!file) return
    setState('previewing')
    setErrorMsg('')
    try {
      const data = await callApi(true)
      setPreview(data)
      setState('confirming')
    } catch (err) {
      setErrorMsg(err.message)
      setState('error')
    }
  }

  // Step 2: confirmed — actual insert
  async function handleConfirm() {
    setState('uploading')
    try {
      const data = await callApi(false)
      setResult(data)
      setState('success')
    } catch (err) {
      setErrorMsg(err.message)
      setState('error')
    }
  }

  function handleReset() {
    setFile(null)
    setState('idle')
    setPreview(null)
    setResult(null)
    setErrorMsg('')
  }

  // ── Success ──────────────────────────────────────────────────
  if (state === 'success' && result) {
    return <SuccessScreen result={result} onReset={handleReset} navigate={navigate} />
  }

  // ── Confirmation ─────────────────────────────────────────────
  if (state === 'confirming' && previewData) {
    return (
      <ConfirmationScreen
        preview={previewData}
        onConfirm={handleConfirm}
        onCancel={() => setState('idle')}
        confirming={false}
      />
    )
  }

  if (state === 'uploading' && previewData) {
    return (
      <ConfirmationScreen
        preview={previewData}
        onConfirm={handleConfirm}
        onCancel={() => setState('idle')}
        confirming={true}
      />
    )
  }

  // ── Upload form (idle / previewing / error) ──────────────────
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Upload timesheet</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Upload your daily or weekly Excel timesheet file.
        </p>
      </div>

      <div className="card p-6 space-y-5">
        {/* Drop zone */}
        <div
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => document.getElementById('file-input').click()}
          className={clsx(
            'border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all',
            dragging
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
              : file
              ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/20'
              : 'border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-600 hover:bg-gray-50 dark:hover:bg-gray-800/30'
          )}
        >
          <input
            id="file-input"
            type="file"
            accept={accept}
            className="hidden"
            onChange={e => pickFile(e.target.files[0])}
          />

          {file ? (
            <>
              <FileSpreadsheet size={36} className="text-emerald-500 mx-auto mb-3" />
              <p className="font-medium text-sm">{file.name}</p>
              <p className="text-xs text-gray-400 mt-1">{(file.size / 1024).toFixed(1)} KB · Click to change</p>
            </>
          ) : (
            <>
              <Upload size={36} className="text-gray-400 mx-auto mb-3" />
              <p className="font-medium text-sm">Drop your Excel file here</p>
              <p className="text-xs text-gray-400 mt-1">or click to browse · .xlsx, .xls, .xlsm · max 10 MB</p>
            </>
          )}
        </div>

        {/* Clock format note */}
        <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3">
          <AlertTriangle size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
            <strong>Use 24-hour clock format.</strong> Times like "09:00 – 17:00" are the most accurate and
            prevent mistakes. AM/PM notation is supported but error-prone — entering "12:00 AM" instead of
            "12:00 PM" is a common mistake that causes mismatches. Your file will be checked automatically.
          </p>
        </div>

        {/* Format hint */}
        <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
          <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Accepted formats</p>
          <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <li>• <strong>Standard weekly:</strong> Day / Date / Project / Stage / Total Hours / Time / Description columns — the company's primary format</li>
            <li>• <strong>Multi-day:</strong> sections separated by "Date: YYYY-MM-DD" labels</li>
            <li>• <strong>Single-day legacy:</strong> any sheet with a date + Time / Project header row</li>
            <li>• Supported time formats: <strong>8:00–11:30</strong>, <strong>9:00 AM – 5:00 PM</strong>, <strong>09:00 – 17:00</strong></li>
          </ul>
        </div>

        {errorMsg && (
          <div className="flex items-start gap-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl p-4">
            <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700 dark:text-red-400 flex-1">{errorMsg}</p>
            <button onClick={() => setErrorMsg('')} className="text-red-400 hover:text-red-600 flex-shrink-0">
              <X size={14} />
            </button>
          </div>
        )}

        <button
          onClick={handlePreview}
          disabled={!file || state === 'previewing'}
          className="btn-primary w-full"
        >
          {state === 'previewing' ? (
            <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Reading file…</>
          ) : (
            <><Upload size={16} /> Submit timesheet</>
          )}
        </button>
      </div>
    </div>
  )
}
