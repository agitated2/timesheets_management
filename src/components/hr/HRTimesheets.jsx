import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { FileText, Download, ChevronDown, ChevronRight, Filter, Building2 } from 'lucide-react'
import { format, parseISO, startOfMonth } from 'date-fns'
import MultiSelect from '../MultiSelect'
import clsx from 'clsx'
import { SkeletonList } from '../Skeleton'
import TimesheetPreview from '../TimesheetPreview'
import { formatInOfficeTime } from '../../lib/datetime'

const PAGE_SIZE = 10

const statusBadge = {
  pending:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

function entryProjectName(e)    { return e.projects?.name || e.project_name || '—' }
function entryStageName(e)      { return e.project_stages?.name || null }
function entryDisciplineName(e) { return e.disciplines?.name || null }

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
    <div className="bg-gray-50 dark:bg-gray-800/40 border-t border-gray-100 dark:border-gray-800 animate-slide-down">
      <TimesheetPreview
        collapsible
        nested
        showTotal={false}
        emptyLabel="No entries"
        entries={entries.map(e => ({
          time_from:       e.time_from,
          time_to:         e.time_to,
          hours_decimal:   e.hours_decimal,
          project_name:    entryProjectName(e),
          stage_name:      entryStageName(e),
          discipline_name: entryDisciplineName(e),
          task:            e.task,
        }))}
      />
    </div>
  )
}

function Row({ label, sub, hours, status, reviewerName, submittedAt, decidedAt, filePath, entries, officeName, officeTimezone }) {
  const [open, setOpen] = useState(false)
  // Office-local, not viewer-local — two HR viewers in different
  // timezones must see the identical "submitted at" string for the same
  // row, or "was this late?" gets a different answer depending on who's
  // asking. See src/lib/datetime.js.
  const stamp = iso => formatInOfficeTime(iso, officeTimezone)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
        {open ? <ChevronDown size={15} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={15} className="text-gray-400 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{label}</p>
          <p className="text-xs text-gray-400 truncate">{sub}</p>
          {submittedAt && (
            <p className="text-xs text-gray-400 truncate">Submitted {stamp(submittedAt)}</p>
          )}
          {status === 'approved' && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 truncate">
              Approved by {reviewerName || '—'}{decidedAt && ` · ${stamp(decidedAt)}`}
            </p>
          )}
          {status === 'rejected' && (
            <p className="text-xs text-red-500 dark:text-red-400 truncate">
              Rejected by {reviewerName || '—'}{decidedAt && ` · ${stamp(decidedAt)}`}
            </p>
          )}
        </div>
        {officeName && (
          <span className="hidden sm:flex items-center gap-1 text-xs text-gray-400 flex-shrink-0" title="Office">
            <Building2 size={11} /> {officeName}
          </span>
        )}
        {status && <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full capitalize hidden sm:inline', statusBadge[status])}>{status}</span>}
        <span className="text-sm font-semibold tabular-nums text-gray-600 dark:text-gray-300 flex-shrink-0">{hours}h</span>
        {filePath === 'inapp' ? (
          <span className="text-xs text-gray-400 flex-shrink-0 italic hidden sm:inline" title="Entered directly in the app — no original file">In-app entry</span>
        ) : filePath ? (
          <span onClick={e => { e.stopPropagation(); downloadFile(filePath) }} className="text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 flex-shrink-0" title="Download original">
            <Download size={15} />
          </span>
        ) : null}
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
  const [officeFilter, setOfficeFilter] = useState([])
  // Real timesheets.status values only. Days with NO timesheet at all
  // ('missing') can't appear here — this tab lists submitted work; see
  // the Compliance tab for the absence view.
  const [statusFilter, setStatusFilter] = useState([])
  const [groupBy, setGroupBy] = useState('date')   // 'date' | 'project'
  const [page, setPage]   = useState(1)

  const [sheets, setSheets]       = useState([])
  const [projects, setProjects]   = useState([])
  const [employees, setEmployees] = useState([])
  const [offices, setOffices]     = useState([])
  const [loading, setLoading]     = useState(true)

  // filter option sources. Offices are restricted to what this viewer can
  // actually see (my_visible_office_ids) — the offices table itself is
  // readable by any authenticated user (needed for pickers elsewhere like
  // onboarding), but there's no reason to offer a non-sees_all_offices HR
  // user a filter option that would only ever return zero rows.
  useEffect(() => {
    Promise.all([
      supabase.from('projects').select('id, name, project_stages(id, name)').order('name'),
      supabase.from('profiles').select('id, full_name, email, office_id').order('full_name'),
      supabase.from('offices').select('id, name, timezone').order('name'),
      supabase.rpc('my_visible_office_ids'),
    ]).then(([p, e, o, v]) => {
      setProjects(p.data || [])
      setEmployees(e.data || [])
      const visible = new Set(v.data || [])
      setOffices((o.data || []).filter(off => visible.has(off.id)))
    })
  }, [])

  const officeById = useMemo(() => new Map(offices.map(o => [o.id, o])), [offices])

  // Employees whose office matches the office filter — timesheets has no
  // office_id of its own, so this feeds into the employee_id filter below
  // rather than being a separate query predicate.
  const officeEmployeeIds = useMemo(() => {
    if (!officeFilter.length) return null
    return employees.filter(e => officeFilter.includes(e.office_id)).map(e => e.id)
  }, [employees, officeFilter])

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('timesheets')
      .select(`id, date, total_hours, status, file_path, employee_id, reviewer_id, created_at, updated_at,
               profiles!employee_id(full_name, email, office_id, offices(name, timezone)),
               reviewer:profiles!reviewer_id(full_name, email),
               timesheet_entries(id, time_from, time_to, hours_decimal, project_name, task, project_id, stage_id, discipline_id, projects(name), project_stages(name), disciplines(name))`)
      .order('date', { ascending: false })
    if (from) q = q.gte('date', from)
    if (to)   q = q.lte('date', to)
    // Office + employee filters intersect rather than one replacing the
    // other — picking an office then also picking one of its employees
    // should narrow further, not reset the office choice. Tracked as
    // null-vs-array (not .length) so an office whose intersection is
    // genuinely empty still applies `.in('employee_id', [])` (zero rows)
    // instead of falling through to "no filter" and showing everything.
    let effectiveEmpFilter = empFilter.length ? empFilter : null
    if (officeEmployeeIds) {
      const officeIdSet = new Set(officeEmployeeIds)
      effectiveEmpFilter = effectiveEmpFilter ? effectiveEmpFilter.filter(id => officeIdSet.has(id)) : officeEmployeeIds
    }
    if (effectiveEmpFilter) q = q.in('employee_id', effectiveEmpFilter)
    if (statusFilter.length) q = q.in('status', statusFilter)
    const { data } = await q
    setSheets(data || [])
    setLoading(false)
    setPage(1)
  }, [from, to, empFilter, officeEmployeeIds, statusFilter])

  useEffect(() => { load() }, [load])

  const officeOptions = useMemo(() => offices.map(o => ({ value: o.id, label: o.name })), [offices])
  const projectOptions = useMemo(() => projects.map(p => ({ value: p.id, label: p.name })), [projects])
  // Stages are scoped to the selected project(s). With no project selected the
  // stage filter is disabled (there is nothing to scope to). All stages of a
  // selected project are offered — active, finished and archived alike.
  const stageOptions = useMemo(() => {
    if (!projFilter.length) return []
    return projects
      .filter(p => projFilter.includes(p.id))
      .flatMap(p => (p.project_stages || []).map(s => ({ value: s.id, label: s.name, sublabel: p.name })))
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
        reviewerName: s.reviewer?.full_name || s.reviewer?.email || null,
        submittedAt: s.created_at,
        decidedAt: s.status !== 'pending' ? s.updated_at : null,
        filePath: s.file_path,
        entries: s._entries,
        officeName: s.profiles?.offices?.name,
        officeTimezone: s.profiles?.offices?.timezone,
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
          reviewerName: s.reviewer?.full_name || s.reviewer?.email || null,
          submittedAt: s.created_at,
          decidedAt: s.status !== 'pending' ? s.updated_at : null,
          filePath: s.file_path,
          entries,
          officeName: s.profiles?.offices?.name,
          officeTimezone: s.profiles?.offices?.timezone,
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
          {offices.length > 1 && (
            <MultiSelect options={officeOptions} value={officeFilter} onChange={v => { setOfficeFilter(v); setPage(1) }} placeholder="All offices" />
          )}
          <MultiSelect
            options={employees.map(e => ({
              value: e.id, label: e.full_name || e.email,
              sublabel: [e.email, officeById.get(e.office_id)?.name].filter(Boolean).join(' · '),
            }))}
            value={empFilter} onChange={setEmpFilter} placeholder="All employees"
          />
          <MultiSelect options={projectOptions} value={projFilter} onChange={v => { setProjFilter(v); setStageFilter([]); setPage(1) }} placeholder="All projects" />
          <MultiSelect options={stageOptions} value={stageFilter} onChange={v => { setStageFilter(v); setPage(1) }} disabled={projFilter.length === 0} placeholder={projFilter.length === 0 ? 'Select a project first' : 'All stages'} />
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
        {/* Empty selection = no filter (show all), matching how the
            MultiSelect filters above behave. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {['pending', 'approved', 'rejected'].map(s => {
            const on = statusFilter.includes(s)
            return (
              <button
                key={s}
                onClick={() => { setStatusFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]); setPage(1) }}
                className={clsx(
                  'px-2.5 py-1.5 rounded-full text-xs font-medium capitalize border transition-colors',
                  on ? `${statusBadge[s]} border-transparent`
                     : 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-gray-300'
                )}
              >
                {s}
              </button>
            )
          })}
          {statusFilter.length > 0 && (
            <button onClick={() => { setStatusFilter([]); setPage(1) }} className="text-xs text-gray-400 hover:text-gray-600 ml-1">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="card overflow-hidden">
        {loading ? (
          <SkeletonList rows={6} />
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
