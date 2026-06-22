import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { FileText, Download, ChevronDown, ChevronRight, Filter } from 'lucide-react'
import { format, parseISO, startOfMonth } from 'date-fns'
import MultiSelect from '../MultiSelect'
import clsx from 'clsx'

const PAGE_SIZE = 10

const statusBadge = {
  pending:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

function entryProjectName(e) { return e.projects?.name || e.project_name || '—' }
function entryStageName(e)   { return e.project_stages?.name || null }

async function downloadFile(filePath) {
  if (!filePath || filePath === 'inapp') { alert('No original file for in-app entries.'); return }
  const { data, error } = await supabase.storage.from('timesheet-files').download(filePath)
  if (error || !data) { alert('Could not download file.'); return }
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url; a.download = filePath.split('/').pop(); a.click()
  URL.revokeObjectURL(url)
}

function EntryTable({ entries }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-800/40 border-t border-gray-100 dark:border-gray-800">
      <div className="hidden sm:grid grid-cols-5 gap-3 px-5 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
        <span>Time</span><span>Hours</span><span>Project</span><span>Stage</span><span>Task</span>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
        {entries.map((e, i) => (
          <div key={e.id ?? i} className="grid grid-cols-2 sm:grid-cols-5 gap-2 px-5 py-2.5 text-sm">
            <span className="font-mono text-xs text-gray-500">{e.time_from ?? '—'}–{e.time_to ?? '—'}</span>
            <span className="font-semibold tabular-nums">{e.hours_decimal != null ? `${e.hours_decimal}h` : '—'}</span>
            <span className="font-medium truncate">{entryProjectName(e)}</span>
            <span className="text-gray-500 truncate">{entryStageName(e) || '—'}</span>
            <span className="text-gray-400 truncate">{e.task || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ label, sub, hours, status, filePath, entries }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
        {open ? <ChevronDown size={15} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={15} className="text-gray-400 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{label}</p>
          <p className="text-xs text-gray-400 truncate">{sub}</p>
        </div>
        {status && <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full capitalize hidden sm:inline', statusBadge[status])}>{status}</span>}
        <span className="text-sm font-semibold tabular-nums text-gray-600 dark:text-gray-300 flex-shrink-0">{hours}h</span>
        {filePath && filePath !== 'inapp' && (
          <span onClick={e => { e.stopPropagation(); downloadFile(filePath) }} className="text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 flex-shrink-0" title="Download original">
            <Download size={15} />
          </span>
        )}
      </button>
      {open && <EntryTable entries={entries} />}
    </div>
  )
}

export default function HRTimesheets() {
  const today = format(new Date(), 'yyyy-MM-dd')
  const [from, setFrom] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'))
  const [to, setTo]     = useState(today)
  const [empFilter, setEmpFilter]   = useState([])
  const [projFilter, setProjFilter] = useState([])
  const [stageFilter, setStageFilter] = useState([])
  const [groupBy, setGroupBy] = useState('date')   // 'date' | 'project'
  const [page, setPage]   = useState(1)

  const [sheets, setSheets]       = useState([])
  const [projects, setProjects]   = useState([])
  const [employees, setEmployees] = useState([])
  const [loading, setLoading]     = useState(true)

  // filter option sources
  useEffect(() => {
    Promise.all([
      supabase.from('projects').select('id, name, project_stages(id, name)').order('name'),
      supabase.from('profiles').select('id, full_name, email').order('full_name'),
    ]).then(([p, e]) => { setProjects(p.data || []); setEmployees(e.data || []) })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('timesheets')
      .select(`id, date, total_hours, status, file_path, employee_id,
               profiles!employee_id(full_name, email),
               timesheet_entries(id, time_from, time_to, hours_decimal, project_name, task, project_id, stage_id, projects(name), project_stages(name))`)
      .order('date', { ascending: false })
    if (from) q = q.gte('date', from)
    if (to)   q = q.lte('date', to)
    if (empFilter.length) q = q.in('employee_id', empFilter)
    const { data } = await q
    setSheets(data || [])
    setLoading(false)
    setPage(1)
  }, [from, to, empFilter])

  useEffect(() => { load() }, [load])

  const projectOptions = useMemo(() => projects.map(p => ({ value: p.id, label: p.name })), [projects])
  const stageOptions = useMemo(() => {
    const src = projFilter.length ? projects.filter(p => projFilter.includes(p.id)) : projects
    return src.flatMap(p => (p.project_stages || []).map(s => ({ value: s.id, label: s.name, sublabel: p.name })))
  }, [projects, projFilter])

  // Apply project/stage filters client-side (on entries)
  const entryMatches = useCallback((e) => {
    if (projFilter.length && !projFilter.includes(e.project_id)) return false
    if (stageFilter.length && !stageFilter.includes(e.stage_id)) return false
    return true
  }, [projFilter, stageFilter])

  const filteredSheets = useMemo(() => {
    const hasEntryFilter = projFilter.length || stageFilter.length
    return sheets
      .map(s => {
        const entries = hasEntryFilter ? (s.timesheet_entries || []).filter(entryMatches) : (s.timesheet_entries || [])
        return { ...s, _entries: entries }
      })
      .filter(s => !hasEntryFilter || s._entries.length > 0)
  }, [sheets, projFilter, stageFilter, entryMatches])

  // Build the paginated row model
  const rowModel = useMemo(() => {
    if (groupBy === 'date') {
      return filteredSheets.map(s => ({
        key: s.id,
        group: null,
        label: s.profiles?.full_name || s.profiles?.email,
        sub: format(parseISO(s.date), 'EEE, MMM d, yyyy'),
        hours: (s._entries.reduce((a, e) => a + (e.hours_decimal || 0), 0)).toFixed(2),
        status: s.status,
        filePath: s.file_path,
        entries: s._entries,
      }))
    }
    // group by project: one row per (project, timesheet)
    const rows = []
    filteredSheets.forEach(s => {
      const byProj = new Map()
      s._entries.forEach(e => {
        const name = entryProjectName(e)
        if (!byProj.has(name)) byProj.set(name, [])
        byProj.get(name).push(e)
      })
      ;[...byProj.entries()].forEach(([name, entries]) => {
        rows.push({
          key: `${s.id}-${name}`,
          group: name,
          label: s.profiles?.full_name || s.profiles?.email,
          sub: format(parseISO(s.date), 'EEE, MMM d, yyyy'),
          hours: entries.reduce((a, e) => a + (e.hours_decimal || 0), 0).toFixed(2),
          status: s.status,
          filePath: s.file_path,
          entries,
        })
      })
    })
    return rows.sort((a, b) => a.group.localeCompare(b.group))
  }, [filteredSheets, groupBy])

  const totalPages = Math.max(1, Math.ceil(rowModel.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const shown = rowModel.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          <Filter size={13} /> Filters
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <MultiSelect options={employees.map(e => ({ value: e.id, label: e.full_name || e.email, sublabel: e.email }))} value={empFilter} onChange={setEmpFilter} placeholder="All employees" />
          <MultiSelect options={projectOptions} value={projFilter} onChange={v => { setProjFilter(v); setStageFilter([]); setPage(1) }} placeholder="All projects" />
          <MultiSelect options={stageOptions} value={stageFilter} onChange={v => { setStageFilter(v); setPage(1) }} placeholder="All stages" />
          <div className="flex items-center gap-2">
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="input text-sm" />
            <span className="text-gray-400 text-sm">–</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="input text-sm" />
          </div>
          <div className="flex gap-1.5">
            {['date', 'project'].map(g => (
              <button key={g} onClick={() => { setGroupBy(g); setPage(1) }}
                className={clsx('flex-1 px-3 py-2 rounded-md text-sm font-medium capitalize transition-colors',
                  groupBy === g ? 'bg-ae7-red text-white'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700')}>
                By {g}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="text-center py-12">
            <FileText size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No timesheets match these filters.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {shown.map((r, i) => {
              const showGroupHeader = groupBy === 'project' && (i === 0 || shown[i - 1].group !== r.group)
              return (
                <div key={r.key}>
                  {showGroupHeader && (
                    <div className="px-5 py-2 bg-gray-50 dark:bg-gray-800/50 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {r.group}
                    </div>
                  )}
                  <Row {...r} />
                </div>
              )
            })}
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-gray-800">
            <span className="text-xs text-gray-400">Page {currentPage} of {totalPages} · {rowModel.length} results</span>
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
