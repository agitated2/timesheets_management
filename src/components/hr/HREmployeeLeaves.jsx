import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Users } from 'lucide-react'
import MultiSelect from '../MultiSelect'
import { StatusBadge, leaveRange } from '../../pages/RequestsPage'
import clsx from 'clsx'

const PAGE_SIZE = 10
const STATUSES = ['all', 'pending_manager', 'pending_hr', 'approved', 'rejected', 'cancelled', 'revoked']
const statusLabel = {
  all: 'All', pending_manager: 'Pending mgr', pending_hr: 'Pending HR',
  approved: 'Approved', rejected: 'Rejected', cancelled: 'Withdrawn', revoked: 'Revoked',
}

export default function HREmployeeLeaves() {
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [empFilter, setEmpFilter] = useState([])
  const [status, setStatus]     = useState('all')
  const [page, setPage]         = useState(1)

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('leave_requests')
        .select(`*, leave_categories(name, is_paid),
                 profiles!employee_id(id, full_name, email),
                 tier1_approver:profiles!tier1_approver_id(full_name, email),
                 hr_approver:profiles!hr_approver_id(full_name, email)`)
        .order('created_at', { ascending: false })
      setRows(data || [])
      setLoading(false)
    }
    load()
  }, [])

  const employeeOptions = useMemo(() => {
    const seen = new Map()
    rows.forEach(r => {
      if (r.profiles && !seen.has(r.profiles.id)) {
        seen.set(r.profiles.id, { value: r.profiles.id, label: r.profiles.full_name || r.profiles.email, sublabel: r.profiles.email })
      }
    })
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [rows])

  const filtered = rows.filter(r =>
    (empFilter.length === 0 || empFilter.includes(r.employee_id)) &&
    (status === 'all' || r.status === status)
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const shown = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="sm:w-72">
          <MultiSelect
            options={employeeOptions}
            value={empFilter}
            onChange={v => { setEmpFilter(v); setPage(1) }}
            placeholder="Filter by employee…"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {STATUSES.map(s => (
            <button
              key={s}
              onClick={() => { setStatus(s); setPage(1) }}
              className={clsx(
                'px-2.5 py-2 rounded-md text-xs font-medium transition-colors',
                status === s
                  ? 'bg-ae7-red text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              )}
            >
              {statusLabel[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="text-center py-12">
            <Users size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No leave records match.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {shown.map(r => (
              <div key={r.id} className="px-5 py-3.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.profiles?.full_name || r.profiles?.email}</p>
                  <p className="text-xs text-gray-400">
                    {r.leave_categories?.name}{r.leave_categories && !r.leave_categories.is_paid && ' · unpaid'} · {leaveRange(r)} · {r.days_count}d
                  </p>
                  {(r.tier1_approver || r.hr_approver) && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {r.tier1_approver && <>Mgr: {r.tier1_approver.full_name || r.tier1_approver.email}</>}
                      {r.tier1_approver && r.hr_approver && ' · '}
                      {r.hr_approver && <>HR: {r.hr_approver.full_name || r.hr_approver.email}</>}
                    </p>
                  )}
                  {r.rejection_reason && <p className="text-xs text-red-500 mt-0.5">Reason: {r.rejection_reason}</p>}
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-gray-800">
            <span className="text-xs text-gray-400">Page {currentPage} of {totalPages}</span>
            <div className="flex gap-1">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-2 py-1 rounded-md text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30">Prev</button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-2 py-1 rounded-md text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
