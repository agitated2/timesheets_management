import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { ShieldAlert, Search } from 'lucide-react'
import { leaveRange } from '../../pages/RequestsPage'
import Pagination from '../Pagination'
import { SkeletonList } from '../Skeleton'

const PAGE_SIZE = 10

export default function HRRevoke() {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [busyId, setBusyId]   = useState(null)
  const [page, setPage]       = useState(1)

  const load = useCallback(async () => {
    const { data } = await supabase.from('leave_requests')
      .select('*, leave_categories(name, is_paid), profiles!employee_id(full_name, email)')
      .eq('status', 'approved')
      .order('start_date', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function revoke(r) {
    if (!confirm(`Revoke ${r.profiles?.full_name || r.profiles?.email}'s approved leave? This restores their balance and unblocks the dates.`)) return
    setBusyId(r.id)
    const { error } = await supabase.rpc('revoke_leave_request', { p_id: r.id })
    setBusyId(null)
    if (error) { alert(error.message); return }
    load()
  }

  const q = search.trim().toLowerCase()
  const filtered = rows.filter(r => !q ||
    (r.profiles?.full_name || '').toLowerCase().includes(q) ||
    (r.profiles?.email || '').toLowerCase().includes(q) ||
    (r.leave_categories?.name || '').toLowerCase().includes(q))
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current    = Math.min(page, totalPages)
  const shown      = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-md px-4 py-3">
        <ShieldAlert size={16} className="flex-shrink-0 mt-0.5" />
        Revoking an approved leave restores the employee's balance and reopens timesheet submission for those dates. IT only.
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} className="input pl-9" placeholder="Search employee or category…" />
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <SkeletonList rows={6} />
        ) : shown.length === 0 ? (
          <div className="text-center py-12">
            <ShieldAlert size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No approved leaves to revoke.</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {shown.map(r => (
                <div key={r.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{r.profiles?.full_name || r.profiles?.email}</p>
                    <p className="text-xs text-gray-400">{r.leave_categories?.name} · {leaveRange(r)} · {r.days_count}d</p>
                  </div>
                  <button onClick={() => revoke(r)} disabled={busyId === r.id} className="btn-danger text-sm flex-shrink-0">
                    {busyId === r.id ? 'Revoking…' : 'Revoke'}
                  </button>
                </div>
              ))}
            </div>
            <Pagination page={current} totalPages={totalPages} onChange={setPage} total={filtered.length} />
          </>
        )}
      </div>
    </div>
  )
}
