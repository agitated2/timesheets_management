import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  ArrowLeft, Download, CheckCircle, XCircle, Hourglass,
  User, Calendar, Clock, FileSpreadsheet, AlertTriangle
} from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'

export default function ReviewPage() {
  const { id } = useParams()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [ts, setTs] = useState(null)
  const [employee, setEmployee] = useState(null)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [rejectionReason, setRejectionReason] = useState('')
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const canReview = ['manager', 'c_suite', 'it'].includes(profile?.role)

  useEffect(() => {
    async function load() {
      const [{ data: sheet }, { data: ents }] = await Promise.all([
        supabase.from('timesheets').select('*, profiles!employee_id(*)').eq('id', id).single(),
        supabase.from('timesheet_entries').select('*').eq('timesheet_id', id).order('time_from'),
      ])
      if (sheet) { setTs(sheet); setEmployee(sheet.profiles) }
      if (ents) setEntries(ents)
      setLoading(false)
    }
    load()
  }, [id])

  async function handleDecision(decision) {
    if (decision === 'rejected' && !rejectionReason.trim()) {
      setError('Please provide a rejection reason.')
      return
    }
    setSubmitting(true)
    setError('')
    const { error: err } = await supabase
      .from('timesheets')
      .update({
        status: decision,
        reviewer_id: profile.id,
        rejection_reason: decision === 'rejected' ? rejectionReason.trim() : null,
      })
      .eq('id', id)
    setSubmitting(false)
    if (err) { setError(err.message); return }
    navigate(-1)
  }

  async function downloadFile() {
    if (!ts?.file_path) return
    const { data, error } = await supabase.storage.from('timesheet-files').download(ts.file_path)
    if (error || !data) { alert('Could not download file.'); return }
    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = ts.file_path.split('/').pop()
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
  if (!ts) return <div className="text-center py-20 text-gray-400">Timesheet not found.</div>

  const statusBadge = {
    pending:  { icon: Hourglass,   cls: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400' },
    approved: { icon: CheckCircle, cls: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400' },
    rejected: { icon: XCircle,     cls: 'text-red-600 bg-red-50 dark:bg-red-950/30 dark:text-red-400' },
  }[ts.status] ?? { icon: Hourglass, cls: 'text-amber-600 bg-amber-50' }
  const SIcon = statusBadge.icon

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-500">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-xl font-bold">Timesheet Review</h1>
      </div>

      {/* Header card */}
      <div className="card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-blue-600 dark:text-blue-400 font-semibold">
              {(employee?.full_name || employee?.email || '?')[0].toUpperCase()}
            </div>
            <div>
              <p className="font-semibold">{employee?.full_name || employee?.email}</p>
              <p className="text-xs text-gray-400">{employee?.email}</p>
            </div>
          </div>
          <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full', statusBadge.cls)}>
            <SIcon size={12} />
            {ts.status.charAt(0).toUpperCase() + ts.status.slice(1)}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <div className="flex items-center gap-2 text-gray-400 mb-1"><Calendar size={13} /><span className="text-xs">Date</span></div>
            <p className="text-sm font-semibold">{format(new Date(ts.date), 'MMM d, yyyy')}</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <div className="flex items-center gap-2 text-gray-400 mb-1"><Clock size={13} /><span className="text-xs">Total hours</span></div>
            <p className="text-sm font-semibold">{ts.total_hours ?? '—'}h</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <div className="flex items-center gap-2 text-gray-400 mb-1"><FileSpreadsheet size={13} /><span className="text-xs">Entries</span></div>
            <p className="text-sm font-semibold">{entries.length}</p>
          </div>
        </div>

        {ts.rejection_reason && (
          <div className="flex items-start gap-3 bg-red-50 dark:bg-red-950/20 rounded-xl p-3">
            <AlertTriangle size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-red-600 dark:text-red-400 mb-0.5">Rejection reason</p>
              <p className="text-sm text-red-700 dark:text-red-300">{ts.rejection_reason}</p>
            </div>
          </div>
        )}

        <button onClick={downloadFile} className="btn-secondary text-sm gap-2">
          <Download size={15} /> Download original file
        </button>
      </div>

      {/* Entries */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">Time entries</h2>
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">No entries parsed</p>
        ) : (
          <>
            <div className="hidden sm:grid grid-cols-4 gap-3 px-5 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
              <span>Time window</span>
              <span>Hours</span>
              <span>Project</span>
              <span>Task</span>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {entries.map((e, i) => (
                <div key={e.id ?? i} className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-5 py-3.5 text-sm">
                  <span className="font-mono text-xs text-gray-500">{e.time_from ?? '—'} – {e.time_to ?? '—'}</span>
                  <span className="font-semibold text-blue-600 dark:text-blue-400">{e.hours_decimal != null ? `${e.hours_decimal}h` : '—'}</span>
                  <span className="font-medium">{e.project_name || '—'}</span>
                  <span className="text-gray-400">{e.task || '—'}</span>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800 flex justify-end">
              <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
                Total: {entries.reduce((s, e) => s + (e.hours_decimal || 0), 0).toFixed(2)}h
              </span>
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      {canReview && ts.status === 'pending' && (
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold text-sm">Decision</h2>

          {showRejectForm ? (
            <div className="space-y-3">
              <div>
                <label className="label">Rejection reason <span className="text-red-500">*</span></label>
                <textarea
                  value={rejectionReason}
                  onChange={e => setRejectionReason(e.target.value)}
                  className="input resize-none"
                  rows={3}
                  placeholder="Explain why this timesheet is being rejected…"
                  autoFocus
                />
              </div>
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <div className="flex gap-3">
                <button onClick={() => { setShowRejectForm(false); setError('') }} className="btn-secondary flex-1">
                  Cancel
                </button>
                <button onClick={() => handleDecision('rejected')} disabled={submitting} className="btn-danger flex-1">
                  {submitting ? 'Submitting…' : 'Confirm rejection'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <button onClick={() => handleDecision('approved')} disabled={submitting} className="btn-success flex-1">
                <CheckCircle size={16} /> Approve
              </button>
              <button onClick={() => setShowRejectForm(true)} className="btn-danger flex-1">
                <XCircle size={16} /> Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
