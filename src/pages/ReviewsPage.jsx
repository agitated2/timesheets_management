import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { Hourglass, CheckSquare, XCircle, Search, ArrowRight, ChevronUp, ChevronDown, ChevronsUpDown, Inbox, ClipboardCheck } from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'
import { SkeletonList } from '../components/Skeleton'
import Pagination from '../components/Pagination'
import Tabs from '../components/Tabs'
import TimesheetCompliance from '../components/TimesheetCompliance'

const PAGE_SIZE = 10

const statusCfg = {
  pending:  { label: 'Pending',  icon: Hourglass,   cls: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400' },
  approved: { label: 'Approved', icon: CheckSquare, cls: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400' },
  rejected: { label: 'Rejected', icon: XCircle,     cls: 'text-red-600 bg-red-50 dark:bg-red-950/30 dark:text-red-400' },
}

function formatStamp(iso) { return format(new Date(iso), 'MMM d, yyyy h:mm a') }

function SortHeader({ label, sortKey, sort, onSort, className }) {
  const active = sort.key === sortKey
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={clsx(
        'flex items-center gap-1 text-left hover:text-gray-700 dark:hover:text-gray-200 transition-colors',
        active && 'text-gray-700 dark:text-gray-200',
        className
      )}
    >
      {label}
      {active ? (
        sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
      ) : (
        <ChevronsUpDown size={12} className="text-gray-300 dark:text-gray-600" />
      )}
    </button>
  )
}

const TABS = [
  { key: 'queue',      label: 'Review queue', icon: Inbox },
  { key: 'compliance', label: 'Compliance',   icon: ClipboardCheck },
]

export default function ReviewsPage() {
  const [active, setActive] = useState('queue')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Timesheet Reviews</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          {active === 'queue'
            ? "Review and approve your team's daily timesheets."
            : "Every day your team owed a timesheet — including days with nothing submitted."}
        </p>
      </div>

      <Tabs tabs={TABS} active={active} onChange={setActive} />

      {/* Same component the HR Panel mounts. timesheet_compliance() scopes
          itself to the caller, so a line manager sees only their own
          reports here without the page passing any scope of its own. */}
      {active === 'queue' ? <ReviewQueue /> : <TimesheetCompliance />}
    </div>
  )
}

function ReviewQueue() {
  const { profile } = useAuth()
  const [timesheets, setTimesheets] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' })
  const [page, setPage] = useState(1)

  function toggleSort(key) {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }
    )
  }

  useEffect(() => {
    load()
  }, [profile.id])

  async function load() {
    let query = supabase
      .from('timesheets')
      .select('*, profiles!employee_id(id, full_name, email)')
      .order('date', { ascending: false })

    // IT sees all; managers/c_suite only see their subordinates
    // RLS enforces this automatically on the server side

    const { data } = await query
    if (data) setTimesheets(data)
    setLoading(false)
  }

  const statusOrder = { pending: 0, approved: 1, rejected: 2 }

  const filtered = timesheets
    .filter(t => filter === 'all' || t.status === filter)
    .filter(t => {
      if (!search) return true
      const q = search.toLowerCase()
      return (
        (t.profiles?.full_name || '').toLowerCase().includes(q) ||
        (t.profiles?.email || '').toLowerCase().includes(q)
      )
    })
    .sort((a, b) => {
      let cmp = 0
      switch (sort.key) {
        case 'employee': {
          const an = (a.profiles?.full_name || a.profiles?.email || '').toLowerCase()
          const bn = (b.profiles?.full_name || b.profiles?.email || '').toLowerCase()
          cmp = an.localeCompare(bn)
          break
        }
        case 'hours':
          cmp = (a.total_hours ?? 0) - (b.total_hours ?? 0)
          break
        case 'status':
          cmp = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0)
          break
        case 'date':
        default:
          cmp = new Date(a.date) - new Date(b.date)
      }
      return sort.dir === 'asc' ? cmp : -cmp
    })

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const shown       = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  function handleSearch(v) { setSearch(v); setPage(1) }
  function handleFilter(f) { setFilter(f); setPage(1) }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className="input pl-9"
            placeholder="Search employee name or email…"
          />
        </div>
        <div className="flex gap-2">
          {['all', 'pending', 'approved', 'rejected'].map(f => (
            <button
              key={f}
              onClick={() => handleFilter(f)}
              className={clsx(
                'px-3 py-2 rounded-md text-sm font-medium transition-colors capitalize',
                filter === f
                  ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="card overflow-hidden"><SkeletonList rows={6} /></div>
      ) : shown.length === 0 ? (
        <div className="card p-12 text-center">
          <CheckSquare size={40} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-gray-500">No {filter !== 'all' ? filter : ''} timesheets.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="hidden sm:grid grid-cols-5 gap-4 px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
            <SortHeader label="Employee" sortKey="employee" sort={sort} onSort={toggleSort} className="col-span-2" />
            <SortHeader label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
            <SortHeader label="Hours" sortKey="hours" sort={sort} onSort={toggleSort} />
            <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {shown.map(t => {
              const { label, icon: Icon, cls } = statusCfg[t.status] ?? statusCfg.pending
              return (
                <Link
                  key={t.id}
                  to={`/review/${t.id}`}
                  className="flex sm:grid sm:grid-cols-5 gap-3 sm:gap-4 items-center px-5 py-3.5 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                >
                  <div className="sm:col-span-2 flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 text-xs font-semibold flex-shrink-0">
                      {(t.profiles?.full_name || t.profiles?.email || '?')[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{t.profiles?.full_name || '(No name)'}</p>
                      <p className="text-xs text-gray-400 truncate">{t.profiles?.email}</p>
                    </div>
                  </div>
                  <div className="hidden sm:block min-w-0">
                    <p className="text-sm">{format(new Date(t.date), 'MMM d, yyyy')}</p>
                    <p className="text-xs text-gray-400 truncate">Submitted {formatStamp(t.created_at)}</p>
                    {t.status !== 'pending' && (
                      <p className={clsx('text-xs truncate', t.status === 'approved' ? 'text-emerald-500' : 'text-red-500')}>
                        {t.status === 'approved' ? 'Approved' : 'Rejected'} {formatStamp(t.updated_at)}
                      </p>
                    )}
                  </div>
                  <span className="text-sm font-semibold hidden sm:block text-blue-600 dark:text-blue-400">{t.total_hours ?? '—'}h</span>
                  <div className="flex items-center justify-between gap-2 ml-auto sm:ml-0">
                    <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full', cls)}>
                      <Icon size={11} /> {label}
                    </div>
                    <ArrowRight size={14} className="text-gray-400 flex-shrink-0" />
                  </div>
                </Link>
              )
            })}
          </div>
          <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} total={filtered.length} />
        </div>
      )}
    </div>
  )
}
