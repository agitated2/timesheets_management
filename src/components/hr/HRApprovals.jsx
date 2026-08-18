import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Inbox, Check, XCircle } from 'lucide-react'
import { StatusBadge, leaveRange } from '../../pages/RequestsPage'
import Pagination from '../Pagination'
import { SkeletonList } from '../Skeleton'

const PAGE_SIZE = 10

function HRDecisionCard({ req, onDecided }) {
  const [busy, setBusy]           = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason]       = useState('')
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
          {req.tier1_approver && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">
              Approved by line manager: {req.tier1_approver.full_name || req.tier1_approver.email}
            </p>
          )}
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
          <Check size={14} /> Final approve
        </button>
        <button onClick={() => decide(false)} disabled={busy} className="btn-danger flex-1 text-sm">
          <XCircle size={14} /> {rejecting ? 'Confirm reject' : 'Reject'}
        </button>
      </div>
    </div>
  )
}

export default function HRApprovals() {
  const [reqs, setReqs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage]       = useState(1)

  const load = useCallback(async () => {
    const { data } = await supabase.from('leave_requests')
      .select('*, leave_categories(name), profiles!employee_id(full_name, email), tier1_approver:profiles!tier1_approver_id(full_name, email)')
      .eq('status', 'pending_hr')
      .order('created_at', { ascending: false })
    setReqs(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const totalPages = Math.max(1, Math.ceil(reqs.length / PAGE_SIZE))
  const current    = Math.min(page, totalPages)
  const shown      = reqs.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
        <Inbox size={15} className="text-gray-400" />
        <h2 className="font-semibold text-sm">Awaiting HR sign-off</h2>
        {reqs.length > 0 && (
          <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full">{reqs.length}</span>
        )}
      </div>
      {loading ? (
        <SkeletonList rows={6} />
      ) : reqs.length === 0 ? (
        <div className="text-center py-12">
          <Inbox size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-500">Nothing awaiting your approval.</p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {shown.map(r => <HRDecisionCard key={r.id} req={r} onDecided={load} />)}
          </div>
          <Pagination page={current} totalPages={totalPages} onChange={setPage} total={reqs.length} />
        </>
      )}
    </div>
  )
}
