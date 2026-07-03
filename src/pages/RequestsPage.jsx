import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  HeartHandshake, Plus, X, CalendarDays, Clock, Hourglass,
  CheckCircle, XCircle, Ban, AlertTriangle, Check, Inbox,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import Pagination from '../components/Pagination'
import clsx from 'clsx'
import { SkeletonList } from '../components/Skeleton'

const PAGE_SIZE = 10

export const LEAVE_STATUS = {
  pending_manager: { label: 'Pending manager', icon: Hourglass,   cls: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400' },
  pending_hr:      { label: 'Pending HR',      icon: Hourglass,   cls: 'text-blue-600 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-400' },
  approved:        { label: 'Approved',        icon: CheckCircle, cls: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400' },
  rejected:        { label: 'Rejected',        icon: XCircle,     cls: 'text-red-600 bg-red-50 dark:bg-red-950/30 dark:text-red-400' },
  cancelled:       { label: 'Withdrawn',       icon: Ban,         cls: 'text-gray-500 bg-gray-100 dark:bg-gray-800 dark:text-gray-400' },
  revoked:         { label: 'Revoked',         icon: Ban,         cls: 'text-red-600 bg-red-50 dark:bg-red-950/30 dark:text-red-400' },
}

export function StatusBadge({ status }) {
  const { label, icon: Icon, cls } = LEAVE_STATUS[status] ?? LEAVE_STATUS.pending_manager
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full', cls)}>
      <Icon size={11} /> {label}
    </span>
  )
}

export function leaveRange(r) {
  if (r.unit === 'hourly') {
    return `${format(parseISO(r.start_date), 'MMM d, yyyy')} · ${r.start_time?.slice(0, 5)}–${r.end_time?.slice(0, 5)}`
  }
  if (r.start_date === r.end_date) return format(parseISO(r.start_date), 'MMM d, yyyy')
  return `${format(parseISO(r.start_date), 'MMM d')} – ${format(parseISO(r.end_date), 'MMM d, yyyy')}`
}

// ── New request form ──────────────────────────────────────────────
function NewRequestModal({ categories, onClose, onSubmitted }) {
  const today = format(new Date(), 'yyyy-MM-dd')
  const [categoryId, setCategoryId] = useState(categories[0]?.id || '')
  const [unit, setUnit]             = useState('daily')
  const [startDate, setStartDate]   = useState(today)
  const [endDate, setEndDate]       = useState(today)
  const [startTime, setStartTime]   = useState('09:00')
  const [endTime, setEndTime]       = useState('13:00')
  const [reason, setReason]         = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')

  const valid = categoryId && startDate &&
    (unit === 'daily' ? endDate >= startDate : (endTime > startTime))

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setSaving(true)
    const { error: err } = await supabase.rpc('submit_leave_request', {
      p_category:   categoryId,
      p_unit:       unit,
      p_start:      startDate,
      p_end:        unit === 'hourly' ? startDate : endDate,
      p_start_time: unit === 'hourly' ? startTime : null,
      p_end_time:   unit === 'hourly' ? endTime   : null,
      p_reason:     reason,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onSubmitted()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">New request</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="label">Category *</label>
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)} className="input" required>
              {categories.length === 0 && <option value="">No categories available</option>}
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.is_paid ? '' : ' (unpaid)'}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Duration type</label>
            <div className="flex gap-2">
              {[['daily', 'Full / multi-day', CalendarDays], ['hourly', 'Hourly (single day)', Clock]].map(([v, lbl, Icon]) => (
                <button
                  type="button"
                  key={v}
                  onClick={() => setUnit(v)}
                  className={clsx(
                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
                    unit === v
                      ? 'bg-ae7-red text-white border-ae7-red'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                  )}
                >
                  <Icon size={14} /> {lbl}
                </button>
              ))}
            </div>
          </div>

          {unit === 'daily' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">From *</label>
                <input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value) }} className="input" required />
              </div>
              <div>
                <label className="label">To *</label>
                <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} className="input" required />
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="label">Date *</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Start time *</label>
                  <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="input" required />
                </div>
                <div>
                  <label className="label">End time *</label>
                  <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className="input" required />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="label">Reason</label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="input resize-none" placeholder="Optional note for your approver…" />
          </div>

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-md px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {error}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={!valid || saving} className="btn-primary flex-1">
              {saving ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Manager decision row ──────────────────────────────────────────
function ApprovalCard({ req, onDecided }) {
  const [busy, setBusy]       = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason]   = useState('')
  const emp = req.profiles

  async function decide(approve) {
    if (!approve && !reason.trim()) { setRejecting(true); return }
    setBusy(true)
    const { error } = await supabase.rpc('decide_leave_request', {
      p_id: req.id, p_approve: approve, p_reason: approve ? null : reason.trim(),
    })
    setBusy(false)
    if (error) { alert(error.message); return }
    onDecided()
  }

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{emp?.full_name || emp?.email}</p>
          <p className="text-xs text-gray-400">
            {req.leave_categories?.name} · {leaveRange(req)} · {req.days_count} day{req.days_count === 1 ? '' : 's'}
          </p>
          {req.reason && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 italic">"{req.reason}"</p>}
        </div>
        <StatusBadge status={req.status} />
      </div>

      {rejecting && (
        <textarea
          value={reason} onChange={e => setReason(e.target.value)} rows={2} autoFocus
          className="input resize-none text-sm" placeholder="Reason for rejection…"
        />
      )}

      <div className="flex gap-2">
        <button onClick={() => decide(true)} disabled={busy} className="btn-success flex-1 text-sm">
          <Check size={14} /> Approve
        </button>
        <button onClick={() => decide(false)} disabled={busy} className="btn-danger flex-1 text-sm">
          <XCircle size={14} /> {rejecting ? 'Confirm reject' : 'Reject'}
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────
export default function RequestsPage() {
  const { profile, hasRole } = useAuth()
  const [categories, setCategories] = useState([])
  const [requests, setRequests]     = useState([])
  const [approvals, setApprovals]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [showNew, setShowNew]       = useState(false)
  const [minePage, setMinePage]     = useState(1)
  const [apprPage, setApprPage]     = useState(1)

  const isManager = hasRole('manager') || hasRole('c_suite') || hasRole('it')

  const load = useCallback(async () => {
    const [cats, reqs] = await Promise.all([
      supabase.from('leave_categories').select('*').eq('is_active', true).order('name'),
      supabase.from('leave_requests')
        .select('*, leave_categories(name, is_paid)')
        .eq('employee_id', profile.id)
        .order('created_at', { ascending: false }),
    ])
    setCategories(cats.data || [])
    setRequests(reqs.data || [])

    if (isManager) {
      const { data } = await supabase.from('leave_requests')
        .select('*, leave_categories(name), profiles!employee_id(full_name, email)')
        .eq('status', 'pending_manager')
        .neq('employee_id', profile.id)
        .order('created_at', { ascending: false })
      setApprovals(data || [])
    }
    setLoading(false)
  }, [profile.id, isManager])

  useEffect(() => { load() }, [load])

  async function withdraw(id) {
    const { error } = await supabase.rpc('withdraw_leave_request', { p_id: id })
    if (error) { alert(error.message); return }
    load()
  }

  const apprTotalPages = Math.max(1, Math.ceil(approvals.length / PAGE_SIZE))
  const apprCurrent    = Math.min(apprPage, apprTotalPages)
  const apprShown      = approvals.slice((apprCurrent - 1) * PAGE_SIZE, apprCurrent * PAGE_SIZE)

  const mineTotalPages = Math.max(1, Math.ceil(requests.length / PAGE_SIZE))
  const mineCurrent    = Math.min(minePage, mineTotalPages)
  const mineShown      = requests.slice((mineCurrent - 1) * PAGE_SIZE, mineCurrent * PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap lg:pr-14">
        <div>
          <h1 className="page-title">Requests</h1>
          <p className="page-subtitle">Submit and track your requests — leave and more.</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary">
          <Plus size={15} /> New request
        </button>
      </div>

      {/* Manager approval queue */}
      {isManager && approvals.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
            <Inbox size={15} className="text-gray-400" />
            <h2 className="font-semibold text-sm">Pending your approval</h2>
            <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full">{approvals.length}</span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {apprShown.map(r => <ApprovalCard key={r.id} req={r} onDecided={load} />)}
          </div>
          <Pagination page={apprCurrent} totalPages={apprTotalPages} onChange={setApprPage} total={approvals.length} />
        </div>
      )}

      {/* My requests */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="font-semibold text-sm">My requests</h2>
        </div>
        {loading ? (
          <SkeletonList rows={4} />
        ) : requests.length === 0 ? (
          <div className="text-center py-12">
            <HeartHandshake size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No requests yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {mineShown.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {r.leave_categories?.name}
                    {r.leave_categories && !r.leave_categories.is_paid && <span className="text-xs text-gray-400 font-normal"> · unpaid</span>}
                  </p>
                  <p className="text-xs text-gray-400">
                    {leaveRange(r)} · {r.days_count} day{r.days_count === 1 ? '' : 's'}
                  </p>
                  {r.rejection_reason && (
                    <p className="text-xs text-red-500 mt-0.5">Reason: {r.rejection_reason}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <StatusBadge status={r.status} />
                  {(r.status === 'pending_manager' || r.status === 'pending_hr') && (
                    <button onClick={() => withdraw(r.id)} className="text-xs text-gray-500 hover:text-red-500 underline">
                      Withdraw
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <Pagination page={mineCurrent} totalPages={mineTotalPages} onChange={setMinePage} total={requests.length} />
      </div>

      {showNew && (
        <NewRequestModal
          categories={categories}
          onClose={() => setShowNew(false)}
          onSubmitted={load}
        />
      )}
    </div>
  )
}
