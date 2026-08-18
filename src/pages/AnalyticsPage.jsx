import { useEffect, useState, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, Tooltip,
  XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend,
} from 'recharts'
import { format, subDays, eachDayOfInterval, isWeekend, parseISO } from 'date-fns'
import { Download, Filter, BarChart2, TrendingUp, ChevronDown, Check } from 'lucide-react'
import clsx from 'clsx'
import Tabs from '../components/Tabs'
import { Skeleton, SkeletonStats } from '../components/Skeleton'

const COLORS = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#14B8A6','#F97316','#6366F1','#84CC16']

function useIsDark() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

const axisColor = (dark) => dark ? '#6B7280' : '#9CA3AF'
const gridColor = (dark) => dark ? '#1F2937' : '#F3F4F6'

function StatPill({ label, value, color = 'blue' }) {
  const colorMap = {
    blue:  'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300',
    green: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300',
    red:   'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300',
  }
  return (
    <div className={clsx('rounded-lg p-4', colorMap[color])}>
      <p className="text-xs font-medium opacity-75 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  )
}

function MultiSelectDropdown({ options, value, onChange, placeholder }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handle(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function toggle(v) {
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])
  }

  const label = value.length === 0
    ? null
    : value.length === 1
      ? (options.find(o => o.value === value[0])?.label || value[0])
      : `${value.length} selected`

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="input text-sm text-left flex items-center justify-between w-full gap-2"
      >
        <span className={clsx('truncate', !label && 'text-gray-400 dark:text-gray-500')}>
          {label || placeholder}
        </span>
        <ChevronDown size={14} className={clsx('text-gray-400 flex-shrink-0 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden">
          {options.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-3">No options available</p>
          ) : (
            <div className="max-h-52 overflow-y-auto divide-y divide-gray-50 dark:divide-gray-800">
              {options.map(opt => (
                <label
                  key={opt.value}
                  className={clsx(
                    'flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors text-sm',
                    value.includes(opt.value) ? 'bg-ae7-light/60 dark:bg-ae7-red/5' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  )}
                >
                  <div className={clsx(
                    'w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                    value.includes(opt.value) ? 'bg-ae7-red border-ae7-red' : 'border-gray-300 dark:border-gray-600'
                  )}>
                    {value.includes(opt.value) && <Check size={9} className="text-white" strokeWidth={3} />}
                  </div>
                  <span className="truncate">{opt.label}</span>
                  <button
                    type="button"
                    onClick={e => { e.preventDefault(); toggle(opt.value) }}
                    className="sr-only"
                  />
                </label>
              ))}
            </div>
          )}
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => { onChange([]); setOpen(false) }}
              className="w-full px-3 py-2 text-xs text-ae7-red hover:bg-ae7-light/40 dark:hover:bg-ae7-red/5 border-t border-gray-100 dark:border-gray-800 text-left transition-colors"
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Project Insights (per-project constraint analytics) ───────────
function ProjectInsights({ dark }) {
  const [projects, setProjects]   = useState([])
  const [projectId, setProjectId] = useState('')
  const [disciplines, setDisciplines] = useState([])
  const [deptFilter, setDeptFilter]   = useState([])
  const [stages, setStages]       = useState([])
  const [entries, setEntries]     = useState([])
  const [loading, setLoading]     = useState(false)
  // Custom fields (migration_v21) assigned anywhere on this project.
  const [customFields, setCustomFields] = useState([])   // { id, name }[]
  const [cfFilter, setCfFilter]   = useState({})         // field_id -> option_id[]
  const [groupByField, setGroupByField] = useState('')   // field_id | ''

  useEffect(() => {
    supabase.from('projects').select('id, name, tracking_type, total_hours').order('name')
      .then(({ data }) => { setProjects(data || []); setProjectId(prev => prev || data?.[0]?.id || '') })
    supabase.from('disciplines').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => setDisciplines(data || []))
  }, [])

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    // Filters/grouping are reset on project change — a field assigned to
    // the previous project may not exist on this one, and a stale filter
    // would silently zero out the charts.
    setCfFilter({})
    setGroupByField('')
    Promise.all([
      supabase.from('project_stages_view').select('*').eq('project_id', projectId).order('order_index'),
      // Custom values come back nested per entry. option_label_snapshot is
      // what the option said when the entry was submitted — see
      // migration_v21; grouping uses the id, display uses the snapshot,
      // so renaming an option later never rewrites past reports.
      supabase.from('timesheet_entries')
        .select(`
          hours_decimal, discipline_id, disciplines(name),
          timesheets!inner(date, status),
          timesheet_entry_field_values(field_id, option_id, option_label_snapshot)
        `)
        .eq('project_id', projectId)
        .in('timesheets.status', ['approved', 'pending']),
      supabase.from('custom_field_assignments')
        .select('field_id, requirement, custom_fields(id, name, is_active)')
        .eq('project_id', projectId),
    ]).then(([s, e, cf]) => {
      setStages(s.data || [])
      setEntries(e.data || [])
      // De-duplicate: a field assigned at both project and stage level
      // returns several rows, but it's one field for reporting purposes.
      const seen = new Map()
      ;(cf.data || []).forEach(a => {
        const f = a.custom_fields
        if (f?.is_active && !seen.has(f.id)) seen.set(f.id, { id: f.id, name: f.name })
      })
      setCustomFields([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)))
      setLoading(false)
    })
  }, [projectId])

  const project = projects.find(p => p.id === projectId)

  // Every option actually present in this project's data, per field.
  // Derived from the entries rather than the full option list so the
  // filter never offers a value that would return nothing here.
  const cfOptionsByField = useMemo(() => {
    const acc = {}
    entries.forEach(e => {
      (e.timesheet_entry_field_values || []).forEach(v => {
        (acc[v.field_id] ||= new Map()).set(v.option_id, v.option_label_snapshot)
      })
    })
    return Object.fromEntries(
      Object.entries(acc).map(([fieldId, m]) => [
        fieldId,
        [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
      ])
    )
  }, [entries])

  // Discipline + custom field filters apply to the logged-hours charts.
  // An entry matches a custom filter if it holds any of the selected
  // options for that field; multiple fields are ANDed together.
  const shownEntries = useMemo(() => {
    let out = deptFilter.length ? entries.filter(e => deptFilter.includes(e.discipline_id)) : entries
    for (const [fieldId, optionIds] of Object.entries(cfFilter)) {
      if (!optionIds?.length) continue
      out = out.filter(e =>
        (e.timesheet_entry_field_values || []).some(v => v.field_id === fieldId && optionIds.includes(v.option_id))
      )
    }
    return out
  }, [entries, deptFilter, cfFilter])

  const deptOptions = useMemo(() => disciplines.map(d => ({ value: d.id, label: d.name })), [disciplines])

  // Hours grouped by the selected custom field. Entries with no value for
  // it fall into an explicit "Unspecified" bucket rather than being
  // dropped (HANDOFF_PLAN decision D-e) — so the grouped total always
  // reconciles against the project total, and gaps in data collection are
  // visible instead of silently shrinking the chart.
  const byCustomField = useMemo(() => {
    if (!groupByField) return []
    const acc = {}
    shownEntries.forEach(e => {
      const v = (e.timesheet_entry_field_values || []).find(x => x.field_id === groupByField)
      const key = v?.option_label_snapshot || 'Unspecified'
      acc[key] = (acc[key] || 0) + (Number(e.hours_decimal) || 0)
    })
    return Object.entries(acc)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 100) / 100 }))
      .sort((a, b) => b.hours - a.hours)
  }, [shownEntries, groupByField])

  // 1. Actual hours logged per stage
  const actualHours = useMemo(() => stages.filter(s => !s.is_archived).map(s => ({
    name: s.name,
    hours: Number(s.logged_hours || 0),
  })), [stages])

  // 2. Workforce by discipline (per-entry discipline the work was logged under)
  const byDiscipline = useMemo(() => {
    const acc = {}
    shownEntries.forEach(e => {
      const d = e.disciplines?.name || 'Unspecified'
      acc[d] = (acc[d] || 0) + (Number(e.hours_decimal) || 0)
    })
    return Object.entries(acc).map(([name, hours]) => ({ name, hours: Math.round(hours * 100) / 100 })).sort((a, b) => b.hours - a.hours)
  }, [shownEntries])

  // 3. Cumulative hours logged over time
  const { burn, totalLogged } = useMemo(() => {
    const byDate = {}
    shownEntries.forEach(e => { const d = e.timesheets?.date; if (d) byDate[d] = (byDate[d] || 0) + (Number(e.hours_decimal) || 0) })
    const dates = Object.keys(byDate).sort()
    let cum = 0
    const series = dates.map(d => { cum += byDate[d]; return { date: format(parseISO(d), 'MMM d'), cumulative: Math.round(cum * 100) / 100 } })
    return { burn: series, totalLogged: Math.round(cum * 100) / 100 }
  }, [shownEntries])

  const tip = { contentStyle: { background: dark ? '#1F2937' : '#FFF', border: 'none', borderRadius: 12, fontSize: 12 } }

  return (
    <div className="space-y-5">
      <div className="card p-4 flex items-center gap-3 flex-wrap">
        <label className="text-sm font-medium">Project</label>
        <select value={projectId} onChange={e => setProjectId(e.target.value)} className="input text-sm max-w-xs">
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="text-sm font-medium">Discipline</label>
        <div className="min-w-[180px]">
          <MultiSelectDropdown options={deptOptions} value={deptFilter} onChange={setDeptFilter} placeholder="All disciplines" />
        </div>

        {/* One filter per custom field that actually has values on this
            project — a field assigned but never filled in offers nothing
            to filter by, so it's omitted rather than shown empty. */}
        {customFields.filter(f => cfOptionsByField[f.id]?.length).map(f => (
          <div key={f.id} className="flex items-center gap-2">
            <label className="text-sm font-medium">{f.name}</label>
            <div className="min-w-[160px]">
              <MultiSelectDropdown
                options={cfOptionsByField[f.id]}
                value={cfFilter[f.id] || []}
                onChange={v => setCfFilter(prev => ({ ...prev, [f.id]: v }))}
                placeholder={`All ${f.name.toLowerCase()}`}
              />
            </div>
          </div>
        ))}

        {project && (
          <span className="text-xs text-gray-500 ml-auto">{totalLogged}h logged</span>
        )}
      </div>

      {loading ? (
        <div className="space-y-4">
          <SkeletonStats count={4} />
          <div className="card p-6"><Skeleton className="h-64 w-full" /></div>
        </div>
      ) : !project ? (
        <div className="card p-12 text-center text-gray-500">No project selected.</div>
      ) : (
        <>
          {/* 1. Actual hours logged per stage */}
          <div className="card p-5">
            <h2 className="font-semibold text-sm mb-4 flex items-center gap-2">
              <BarChart2 size={16} className="text-blue-500" /> Actual hours logged by stage
            </h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={actualHours} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor(dark)} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: axisColor(dark) }} />
                <YAxis tick={{ fontSize: 11, fill: axisColor(dark) }} />
                <Tooltip {...tip} formatter={(v) => [v + 'h', 'Hours']} />
                <Bar dataKey="hours" name="Hours" fill="#3B82F6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* 1b. Hours grouped by a custom field. Only offered when the
              project actually has fields with data — otherwise this is an
              empty control that never does anything. */}
          {customFields.filter(f => cfOptionsByField[f.id]?.length).length > 0 && (
            <div className="card p-5">
              <div className="flex items-center gap-3 flex-wrap mb-4">
                <h2 className="font-semibold text-sm flex items-center gap-2">
                  <BarChart2 size={16} className="text-blue-500" /> Hours by
                </h2>
                <select
                  value={groupByField}
                  onChange={e => setGroupByField(e.target.value)}
                  className="input text-sm max-w-[220px]"
                >
                  <option value="">Select a field…</option>
                  {customFields.filter(f => cfOptionsByField[f.id]?.length).map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>

              {!groupByField ? (
                <p className="text-sm text-gray-400 text-center py-12">
                  Pick a custom field to break the logged hours down by it.
                </p>
              ) : byCustomField.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-12">No logged hours match the current filters.</p>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={byCustomField} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={gridColor(dark)} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: axisColor(dark) }} />
                      <YAxis tick={{ fontSize: 11, fill: axisColor(dark) }} />
                      <Tooltip {...tip} formatter={(v) => [v + 'h', 'Hours']} />
                      <Bar dataKey="hours" name="Hours" fill="#8B5CF6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  {byCustomField.some(b => b.name === 'Unspecified') && (
                    <p className="text-xs text-gray-400 mt-2">
                      "Unspecified" covers entries logged without a value for this field — including any
                      submitted before it was added to this project.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* 2. Workforce by discipline */}
            <div className="card p-5">
              <h2 className="font-semibold text-sm mb-4">Workforce by discipline</h2>
              {byDiscipline.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-16">No logged hours yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={byDiscipline} dataKey="hours" nameKey="name" cx="50%" cy="50%" outerRadius={85} innerRadius={48} paddingAngle={3}>
                      {byDiscipline.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip {...tip} formatter={(v) => [v + 'h', 'Hours']} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} formatter={v => v.length > 18 ? v.slice(0, 18) + '…' : v} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* 3. Cumulative hours logged */}
            <div className="card p-5">
              <h2 className="font-semibold text-sm mb-4 flex items-center gap-2">
                <TrendingUp size={16} className="text-blue-500" /> Cumulative hours logged
              </h2>
              {burn.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-16">No logged hours yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={burn} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor(dark)} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: axisColor(dark) }} interval={Math.max(0, Math.floor(burn.length / 7))} />
                    <YAxis tick={{ fontSize: 11, fill: axisColor(dark) }} />
                    <Tooltip {...tip} formatter={(v) => [v + 'h', 'Cumulative']} />
                    <Line type="monotone" dataKey="cumulative" stroke="#3B82F6" strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default function AnalyticsPage() {
  const { profile, hasRole } = useAuth()
  const dark = useIsDark()
  const [tab, setTab] = useState('overview')
  const isGlobal = hasRole('global_analytics')
  const isTeamAnalytics = hasRole('team_analytics') && !isGlobal

  const [employees, setEmployees] = useState([])
  const [projects,  setProjects]  = useState([])
  const [disciplines, setDisciplines] = useState([])
  const [allData,   setAllData]   = useState([])

  const [startDate,   setStartDate]   = useState(format(subDays(new Date(), 30), 'yyyy-MM-dd'))
  const [endDate,     setEndDate]     = useState(format(new Date(), 'yyyy-MM-dd'))
  const [empFilters,  setEmpFilters]  = useState([])
  const [projFilters, setProjFilters] = useState([])
  const [deptFilters, setDeptFilters] = useState([])
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    loadData()
  }, [startDate, endDate])

  async function loadData() {
    setLoading(true)
    const { data } = await supabase
      .from('timesheet_entries')
      .select(`
        id, project_name, task, time_from, time_to, hours_decimal, discipline_id, stage_id,
        disciplines ( name ),
        project_stages ( name ),
        timesheets!inner (
          id, date, status, employee_id,
          profiles!employee_id ( id, full_name, email )
        )
      `)
      .gte('timesheets.date', startDate)
      .lte('timesheets.date', endDate)
      .eq('timesheets.status', 'approved')

    if (data) {
      setAllData(data)
      const uniqueEmps = {}
      const uniqueProjs = new Set()
      const uniqueDiscs = {}
      data.forEach(e => {
        const p = e.timesheets?.profiles
        if (p) uniqueEmps[p.id] = p
        if (e.project_name) uniqueProjs.add(e.project_name.trim())
        if (e.discipline_id && e.disciplines?.name) uniqueDiscs[e.discipline_id] = e.disciplines.name
      })
      setEmployees(Object.values(uniqueEmps).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')))
      setProjects([...uniqueProjs].sort())
      setDisciplines(Object.entries(uniqueDiscs).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)))
    }
    setLoading(false)
  }

  const filtered = useMemo(() => {
    return allData.filter(e => {
      if (empFilters.length > 0 && !empFilters.includes(e.timesheets?.profiles?.id)) return false
      if (projFilters.length > 0 && !projFilters.includes((e.project_name || '').trim())) return false
      if (deptFilters.length > 0 && !deptFilters.includes(e.discipline_id)) return false
      return true
    })
  }, [allData, empFilters, projFilters, deptFilters])

  // Hours grouped by discipline the work was logged under
  const byDiscipline = useMemo(() => {
    const acc = {}
    filtered.forEach(e => {
      const name = e.disciplines?.name || 'Unspecified'
      acc[name] = (acc[name] || 0) + (e.hours_decimal || 0)
    })
    return Object.entries(acc)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 100) / 100 }))
      .sort((a, b) => b.hours - a.hours)
  }, [filtered])

  // Cost view: per-employee hours split by the discipline each entry was logged
  // under — surfaces cross-discipline work.
  const empByDiscipline = useMemo(() => {
    const acc = {}
    filtered.forEach(e => {
      const p = e.timesheets?.profiles
      const emp = p?.full_name || p?.email || 'Unknown'
      const disc = e.disciplines?.name || 'Unspecified'
      acc[emp] ||= { total: 0, byDisc: {} }
      acc[emp].byDisc[disc] = (acc[emp].byDisc[disc] || 0) + (e.hours_decimal || 0)
      acc[emp].total += (e.hours_decimal || 0)
    })
    return Object.entries(acc)
      .map(([emp, v]) => ({
        emp,
        total: Math.round(v.total * 100) / 100,
        breakdown: Object.entries(v.byDisc)
          .map(([name, h]) => ({ name, hours: Math.round(h * 100) / 100 }))
          .sort((a, b) => b.hours - a.hours),
      }))
      .sort((a, b) => b.total - a.total)
  }, [filtered])

  // Hours by project
  const byProject = useMemo(() => {
    const acc = {}
    filtered.forEach(e => {
      const name = (e.project_name || 'Unknown').trim()
      acc[name] = (acc[name] || 0) + (e.hours_decimal || 0)
    })
    return Object.entries(acc)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 100) / 100 }))
      .sort((a, b) => b.hours - a.hours)
  }, [filtered])

  // Hours by day
  const byDay = useMemo(() => {
    const acc = {}
    filtered.forEach(e => {
      const d = e.timesheets?.date
      if (d) acc[d] = (acc[d] || 0) + (e.hours_decimal || 0)
    })
    const interval = eachDayOfInterval({ start: parseISO(startDate), end: parseISO(endDate) })
    return interval.map(day => {
      const key = format(day, 'yyyy-MM-dd')
      return {
        date: format(day, 'MMM d'),
        fullDate: key,
        hours: Math.round((acc[key] || 0) * 100) / 100,
        weekend: isWeekend(day),
      }
    })
  }, [filtered, startDate, endDate])

  // Days missed (weekdays with no submission, per employee)
  const missedDays = useMemo(() => {
    const submittedByEmp = {}
    allData.forEach(e => {
      const empId = e.timesheets?.profiles?.id
      const date = e.timesheets?.date
      if (empId && date) {
        if (!submittedByEmp[empId]) submittedByEmp[empId] = new Set()
        submittedByEmp[empId].add(date)
      }
    })
    const interval = eachDayOfInterval({ start: parseISO(startDate), end: parseISO(endDate) })
    const weekdays = interval.filter(d => !isWeekend(d)).map(d => format(d, 'yyyy-MM-dd'))

    const targetEmps = empFilters.length > 0
      ? empFilters
      : isGlobal
        ? Object.keys(submittedByEmp)
        : isTeamAnalytics
          ? employees.map(e => e.id)
          : [profile.id]

    const missed = {}
    targetEmps.forEach(id => {
      const submitted = submittedByEmp[id] || new Set()
      missed[id] = weekdays.filter(d => !submitted.has(d)).length
    })
    return missed
  }, [allData, startDate, endDate, empFilters, employees, isGlobal, isTeamAnalytics, profile.id])

  const totalHours = filtered.reduce((s, e) => s + (e.hours_decimal || 0), 0)
  const uniqueDays = new Set(filtered.map(e => e.timesheets?.date)).size
  const avgPerDay = uniqueDays ? totalHours / uniqueDays : 0
  const totalMissed = Object.values(missedDays).reduce((s, v) => s + v, 0)

  function downloadCSV() {
    const rows = [['Employee', 'Date', 'Project', 'Stage', 'Discipline', 'Task', 'Time From', 'Time To', 'Hours']]
    filtered.forEach(e => {
      const p = e.timesheets?.profiles
      rows.push([
        p?.full_name || p?.email || '',
        e.timesheets?.date || '',
        e.project_name || '',
        e.project_stages?.name || '',
        e.disciplines?.name || '',
        e.task || '',
        e.time_from || '',
        e.time_to || '',
        e.hours_decimal ?? '',
      ])
    })
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `timesheet_export_${startDate}_${endDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const empOptions  = employees.map(e => ({ value: e.id,    label: e.full_name || e.email }))
  const projOptions = projects.map(p =>  ({ value: p,       label: p }))
  const deptOptions = disciplines.map(d => ({ value: d.id,  label: d.name }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 lg:pr-14">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Approved timesheets only</p>
        </div>
        <button onClick={downloadCSV} className="btn-secondary gap-2 text-sm">
          <Download size={15} /> Export CSV
        </button>
      </div>

      <Tabs tabs={[{ key: 'overview', label: 'Overview' }, { key: 'projects', label: 'Projects' }]} active={tab} onChange={setTab} />

      {tab === 'projects' && <ProjectInsights dark={dark} />}

      {tab === 'overview' && (<>
      {/* Filters */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter size={14} className="text-gray-400" />
          <span className="text-sm font-medium">Filters</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label text-xs">From</label>
            <input type="date" value={startDate} max={endDate} onChange={e => setStartDate(e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label className="label text-xs">To</label>
            <input type="date" value={endDate} min={startDate} max={format(new Date(), 'yyyy-MM-dd')} onChange={e => setEndDate(e.target.value)} className="input text-sm" />
          </div>
          {(isGlobal || isTeamAnalytics) && (
            <div>
              <label className="label text-xs">
                Employee
                {empFilters.length > 0 && <span className="ml-1 text-ae7-red">{empFilters.length} selected</span>}
              </label>
              <MultiSelectDropdown
                options={empOptions}
                value={empFilters}
                onChange={setEmpFilters}
                placeholder="All employees"
              />
            </div>
          )}
          <div>
            <label className="label text-xs">
              Project
              {projFilters.length > 0 && <span className="ml-1 text-ae7-red">{projFilters.length} selected</span>}
            </label>
            <MultiSelectDropdown
              options={projOptions}
              value={projFilters}
              onChange={setProjFilters}
              placeholder="All projects"
            />
          </div>
          <div>
            <label className="label text-xs">
              Discipline
              {deptFilters.length > 0 && <span className="ml-1 text-ae7-red">{deptFilters.length} selected</span>}
            </label>
            <MultiSelectDropdown
              options={deptOptions}
              value={deptFilters}
              onChange={setDeptFilters}
              placeholder="All disciplines"
            />
          </div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatPill label="Total hours"    value={totalHours.toFixed(1) + 'h'} color="blue" />
        <StatPill label="Active days"    value={uniqueDays}                   color="green" />
        <StatPill label="Avg hrs/day"    value={avgPerDay.toFixed(1) + 'h'}  color="blue" />
        <StatPill label="Days missed"    value={totalMissed}                  color={totalMissed > 0 ? 'amber' : 'green'} />
      </div>

      {loading ? (
        <div className="space-y-4">
          <SkeletonStats count={4} />
          <div className="card p-6"><Skeleton className="h-64 w-full" /></div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <BarChart2 size={40} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-gray-500">No approved timesheets in this period.</p>
        </div>
      ) : (
        <>
          {/* Hours over time */}
          <div className="card p-5">
            <h2 className="font-semibold text-sm mb-4 flex items-center gap-2">
              <TrendingUp size={16} className="text-blue-500" />
              Hours over time
            </h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={byDay} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor(dark)} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: axisColor(dark) }}
                  interval={Math.floor(byDay.length / 7)}
                />
                <YAxis tick={{ fontSize: 11, fill: axisColor(dark) }} />
                <Tooltip
                  contentStyle={{ background: dark ? '#1F2937' : '#FFF', border: 'none', borderRadius: 12, fontSize: 12 }}
                  labelStyle={{ fontWeight: 600 }}
                />
                <Line
                  type="monotone"
                  dataKey="hours"
                  stroke="#3B82F6"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: '#3B82F6' }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Hours by project */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="card p-5">
              <h2 className="font-semibold text-sm mb-4 flex items-center gap-2">
                <BarChart2 size={16} className="text-blue-500" />
                Hours by project
              </h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byProject.slice(0, 10)} layout="vertical" margin={{ top: 5, right: 10, bottom: 5, left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor(dark)} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: axisColor(dark) }} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tick={{ fontSize: 11, fill: axisColor(dark) }}
                    width={76}
                    tickFormatter={v => v.length > 14 ? v.slice(0, 14) + '…' : v}
                  />
                  <Tooltip
                    contentStyle={{ background: dark ? '#1F2937' : '#FFF', border: 'none', borderRadius: 12, fontSize: 12 }}
                    formatter={(v) => [v + 'h', 'Hours']}
                  />
                  <Bar dataKey="hours" radius={[0, 6, 6, 0]}>
                    {byProject.slice(0, 10).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Project distribution pie */}
            <div className="card p-5">
              <h2 className="font-semibold text-sm mb-4">Project distribution</h2>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={byProject.slice(0, 8)}
                    dataKey="hours"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    innerRadius={45}
                    paddingAngle={3}
                  >
                    {byProject.slice(0, 8).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: dark ? '#1F2937' : '#FFF', border: 'none', borderRadius: 12, fontSize: 12 }}
                    formatter={(v) => [v + 'h', 'Hours']}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11 }}
                    formatter={(v) => v.length > 16 ? v.slice(0, 16) + '…' : v}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Hours by discipline + cross-discipline cost view */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="card p-5">
              <h2 className="font-semibold text-sm mb-4 flex items-center gap-2">
                <BarChart2 size={16} className="text-blue-500" /> Hours by discipline
              </h2>
              {byDiscipline.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-16">No discipline data.</p>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={byDiscipline.slice(0, 10)} layout="vertical" margin={{ top: 5, right: 10, bottom: 5, left: 80 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor(dark)} horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: axisColor(dark) }} />
                    <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: axisColor(dark) }} width={76}
                      tickFormatter={v => v.length > 14 ? v.slice(0, 14) + '…' : v} />
                    <Tooltip contentStyle={{ background: dark ? '#1F2937' : '#FFF', border: 'none', borderRadius: 12, fontSize: 12 }} formatter={(v) => [v + 'h', 'Hours']} />
                    <Bar dataKey="hours" radius={[0, 6, 6, 0]}>
                      {byDiscipline.slice(0, 10).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <h2 className="font-semibold text-sm">By employee &amp; discipline</h2>
                <p className="text-xs text-gray-400 mt-0.5">Cross-discipline work per person, for cost optimisation.</p>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-800 max-h-[300px] overflow-y-auto">
                {empByDiscipline.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">No data.</p>
                ) : empByDiscipline.map(row => (
                  <div key={row.emp} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium truncate">{row.emp}</span>
                      <span className="text-sm font-bold tabular-nums flex-shrink-0">{row.total}h</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {row.breakdown.map((b, i) => (
                        <span key={b.name} className={clsx(
                          'text-xs px-2 py-0.5 rounded-full',
                          row.breakdown.length > 1
                            ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        )}>
                          <span className="w-1.5 h-1.5 rounded-full inline-block mr-1 align-middle" style={{ background: COLORS[i % COLORS.length] }} />
                          {b.name}: {b.hours}h
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Project breakdown table */}
          {byProject.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <h2 className="font-semibold text-sm">Project breakdown</h2>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {byProject.map((p, i) => {
                  const pct = totalHours > 0 ? (p.hours / totalHours) * 100 : 0
                  return (
                    <div key={p.name} className="flex items-center gap-4 px-5 py-3">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="text-sm font-medium flex-1 truncate">{p.name}</span>
                      <div className="flex-1 hidden sm:block">
                        <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: COLORS[i % COLORS.length] }} />
                        </div>
                      </div>
                      <span className="text-sm font-bold w-16 text-right">{p.hours}h</span>
                      <span className="text-xs text-gray-400 w-10 text-right">{pct.toFixed(0)}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
      </>)}
    </div>
  )
}
