import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  CheckSquare, XCircle, Hourglass, Download,
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Clock,
} from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'

const PAGE_SIZE = 10

const statusConfig = {
  pending:  { label: 'Pending',  icon: Hourglass,   color: 'text-amber-600 dark:text-amber-400',    bg: 'bg-amber-50  dark:bg-amber-950/30' },
  approved: { label: 'Approved', icon: CheckSquare, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
  rejected: { label: 'Rejected', icon: XCircle,     color: 'text-red-600 dark:text-red-400',        bg: 'bg-red-50    dark:bg-red-950/30' },
}

function getPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const set = new Set([1, total, current, current - 1, current + 1].filter(p => p >= 1 && p <= total))
  const sorted = [...set].sort((a, b) => a - b)
  const result = []
  let prev = 0
  for (const p of sorted) {
    if (p - prev > 1) result.push('...')
    result.push(p)
    prev = p
  }
  return result
}

function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null
  const pages = getPageNumbers(page, totalPages)
  return (
    <div className="flex items-center justify-center gap-1 pt-2">
      <button
        onClick={() => onChange(page - 1)}
        disabled={page === 1}
        className="p-2 rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronLeft size={16} />
      </button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`e${i}`} className="w-9 text-center text-sm text-gray-400">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={clsx(
              'w-9 h-9 rounded-xl text-sm font-medium transition-colors',
              p === page
                ? 'bg-ae7-red text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            )}
          >
            {p}
          </button>
        )
      )}
      <button
        onClick={() => onChange(page + 1)}
        disabled={page === totalPages}
        className="p-2 rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

function TimesheetRow({ ts }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState(null)
  const { label, icon: Icon, color, bg } = statusConfig[ts.status] ?? statusConfig.pending

  async function loadEntries() {
    if (entries) return
    const { data } = await supabase
      .from('timesheet_entries')
      .select('*')
      .eq('timesheet_id', ts.id)
      .order('time_from')
    setEntries(data ?? [])
  }

  async function downloadFile() {
    const { data, error } = await supabase.storage
      .from('timesheet-files')
      .download(ts.file_path)
    if (error || !data) { alert('Could not download file.'); return }
    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = ts.file_path.split('/').pop()
    a.click()
    URL.revokeObjectURL(url)
  }

  const toggle = () => {
    if (!open) loadEntries()
    setOpen(o => !o)
  }

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
        onClick={toggle}
      >
        <div className="flex items-center gap-4 min-w-0">
          <div>
            <p className="font-medium text-sm">{format(new Date(ts.date), 'EEEE, MMMM d, yyyy')}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {ts.total_hours ? `${ts.total_hours}h logged` : 'Hours not recorded'}
              {ts.rejection_reason && (
                <span className="ml-2 text-red-500">· Reason: {ts.rejection_reason}</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full', bg, color)}>
            <Icon size={12} />
            {label}
          </div>
          <button
            onClick={e => { e.stopPropagation(); downloadFile() }}
            title="Download original file"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <Download size={15} />
          </button>
          {open ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-800 px-5 py-4 bg-gray-50/50 dark:bg-gray-800/20">
          {entries === null ? (
            <p className="text-sm text-gray-400 text-center py-2">Loading entries…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-2">No parsed entries</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider px-1">
                <span>Time</span>
                <span>Project</span>
                <span>Task</span>
              </div>
              {entries.map(e => (
                <div key={e.id} className="grid grid-cols-3 gap-2 text-sm bg-white dark:bg-gray-900 rounded-xl px-3 py-2.5 border border-gray-100 dark:border-gray-800">
                  <span className="text-gray-500 text-xs font-mono">
                    {e.time_from ?? '—'} – {e.time_to ?? '—'}{e.hours_decimal ? ` (${e.hours_decimal}h)` : ''}
                  </span>
                  <span className="font-medium truncate">{e.project_name || '—'}</span>
                  <span className="text-gray-500 truncate">{e.task || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function HistoryPage() {
  const { profile } = useAuth()
  const [timesheets, setTimesheets] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)

  useEffect(() => {
    supabase
      .from('timesheets')
      .select('*')
      .eq('employee_id', profile.id)
      .order('date', { ascending: false })
      .then(({ data }) => { if (data) setTimesheets(data); setLoading(false) })
  }, [profile.id])

  function changeFilter(f) {
    setFilter(f)
    setPage(1)
  }

  const shown = filter === 'all' ? timesheets : timesheets.filter(t => t.status === filter)
  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paginated = shown.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const countLabel = filter === 'all'
    ? `${shown.length} total`
    : `${shown.length} ${filter}`

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">My submissions</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{countLabel}</p>
        </div>
        <Link to="/upload" className="btn-primary"><Clock size={16} /> Upload new</Link>
      </div>

      <div className="flex gap-2 flex-wrap">
        {['all', 'pending', 'approved', 'rejected'].map(f => (
          <button
            key={f}
            onClick={() => changeFilter(f)}
            className={clsx(
              'px-3 py-1.5 rounded-xl text-sm font-medium transition-colors capitalize',
              filter === f
                ? 'bg-ae7-red text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="card p-12 text-center">
          <Clock size={40} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-gray-500">No {filter !== 'all' ? filter : ''} submissions found.</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {paginated.map(ts => <TimesheetRow key={ts.id} ts={ts} />)}
          </div>
          <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
        </>
      )}
    </div>
  )
}
