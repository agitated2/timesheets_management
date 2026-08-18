// Shared compliance view: one row per employee-day across all four
// states, including 'missing' days that have no timesheet row at all.
//
// Deliberately takes NO scope props. timesheet_compliance() derives its
// whole scope from auth.uid() server-side — HR sees their visible
// offices, a line manager sees only their direct reports — so the same
// component is mounted unchanged in both the HR Panel and the Reviews
// page, and there is nothing a client could tamper with to widen it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO, startOfMonth, endOfMonth } from 'date-fns'
import {
  AlertCircle, CheckSquare, Hourglass, XCircle, Clock, ArrowRight, RefreshCw,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import MultiSelect from './MultiSelect'
import Pagination from './Pagination'
import { SkeletonList } from './Skeleton'

const PAGE_SIZE = 15

// Mirrors the server's own vocabulary — 'missing' is a computed absence,
// the other three are real timesheets.status values.
const STATES = {
  missing:  { label: 'Missing',  icon: AlertCircle, cls: 'text-red-600 bg-red-50 dark:bg-red-950/30 dark:text-red-400' },
  pending:  { label: 'Pending',  icon: Hourglass,   cls: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400' },
  approved: { label: 'Approved', icon: CheckSquare, cls: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400' },
  rejected: { label: 'Rejected', icon: XCircle,     cls: 'text-red-600 bg-red-50 dark:bg-red-950/30 dark:text-red-400' },
}
const STATE_KEYS = ['missing', 'pending', 'approved', 'rejected']

const iso = d => format(d, 'yyyy-MM-dd')

export default function TimesheetCompliance() {
  const [from, setFrom] = useState(iso(startOfMonth(new Date())))
  const [to, setTo]     = useState(iso(endOfMonth(new Date())))
  // Default to the states that need action. Someone opening this tab
  // wants to know who still owes work, not to scroll past a wall of
  // already-approved days.
  const [states, setStates]     = useState(['missing', 'pending'])
  const [empFilter, setEmp]     = useState([])
  const [lateOnly, setLateOnly] = useState(false)
  const [page, setPage]         = useState(1)

  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const { data, error: err } = await supabase.rpc('timesheet_compliance', {
      p_from: from,
      p_to: to,
    })
    setLoading(false)
    if (err) { setError(err.message); setRows([]); return }
    setRows(data || [])
  }, [from, to])

  useEffect(() => { load() }, [load])
  // Any filter change can shrink the result below the current page.
  useEffect(() => { setPage(1) }, [states, empFilter, lateOnly, from, to])

  // Employee options come from the returned rows rather than a separate
  // profiles query — the RPC has already applied the scope, so this can
  // never offer a name the viewer isn't allowed to see.
  const employeeOptions = useMemo(() => {
    const seen = new Map()
    for (const r of rows) {
      if (!seen.has(r.employee_id)) seen.set(r.employee_id, r.full_name || r.email)
    }
    return [...seen].map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [rows])

  const filtered = useMemo(() => rows.filter(r =>
    (states.length === 0 || states.includes(r.state)) &&
    (empFilter.length === 0 || empFilter.includes(r.employee_id)) &&
    (!lateOnly || r.is_late === true)
  ), [rows, states, empFilter, lateOnly])

  // Counts are of the date range as a whole, not the current filter —
  // they're the summary you scan before deciding what to filter to.
  const counts = useMemo(() => {
    const c = { missing: 0, pending: 0, approved: 0, rejected: 0, late: 0 }
    for (const r of rows) {
      if (c[r.state] !== undefined) c[r.state]++
      if (r.is_late === true) c.late++
    }
    return c
  }, [rows])

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const shown       = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  function toggleState(key) {
    setStates(prev => prev.includes(key) ? prev.filter(s => s !== key) : [...prev, key])
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="card p-4 space-y-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label">From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label className="label">To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="input text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Employee</label>
            <MultiSelect
              options={employeeOptions}
              value={empFilter}
              onChange={setEmp}
              placeholder="All employees"
              showSelectAll
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {STATE_KEYS.map(key => {
            const { label, icon: Icon, cls } = STATES[key]
            const on = states.includes(key)
            return (
              <button
                key={key}
                onClick={() => toggleState(key)}
                className={clsx(
                  'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border transition-colors',
                  on
                    ? `${cls} border-transparent`
                    : 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-gray-300'
                )}
              >
                <Icon size={13} />
                {label}
                <span className="opacity-60">{counts[key]}</span>
              </button>
            )
          })}

          <button
            onClick={() => setLateOnly(v => !v)}
            title="Submitted after the office's daily deadline"
            className={clsx(
              'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border transition-colors',
              lateOnly
                ? 'text-orange-600 bg-orange-50 dark:bg-orange-950/30 dark:text-orange-400 border-transparent'
                : 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-gray-300'
            )}
          >
            <Clock size={13} /> Late only <span className="opacity-60">{counts.late}</span>
          </button>

          <button onClick={load} disabled={loading} className="btn-secondary text-xs ml-auto">
            <RefreshCw size={13} className={clsx(loading && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
          <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Results */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-5"><SkeletonList /></div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-12">
            {rows.length === 0
              ? 'Nothing owed in this date range.'
              : 'No rows match these filters.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-2.5 font-medium">Employee</th>
                  <th className="px-4 py-2.5 font-medium">Office</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium text-right">Hours</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const cfg = STATES[r.state] ?? STATES.missing
                  const Icon = cfg.icon
                  return (
                    <tr
                      key={`${r.employee_id}:${r.work_date}`}
                      className="border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <p className="font-medium truncate">{r.full_name || r.email}</p>
                        {r.full_name && <p className="text-xs text-gray-400 truncate">{r.email}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 text-xs">{r.office_name}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {format(parseISO(r.work_date), 'EEE d MMM yyyy')}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={clsx('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full', cfg.cls)}>
                            <Icon size={11} /> {cfg.label}
                          </span>
                          {r.is_late === true && (
                            <span
                              title="Submitted after the office's daily deadline"
                              className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full text-orange-600 bg-orange-50 dark:bg-orange-950/30 dark:text-orange-400"
                            >
                              <Clock size={11} /> Late
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 dark:text-gray-400">
                        {r.total_hours != null ? Number(r.total_hours).toFixed(2) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {r.timesheet_id && (
                          <Link
                            to={`/review/${r.timesheet_id}`}
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline whitespace-nowrap"
                          >
                            View <ArrowRight size={12} />
                          </Link>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} total={filtered.length} />
      </div>
    </div>
  )
}
