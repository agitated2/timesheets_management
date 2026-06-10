import { useEffect, useState, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, Tooltip,
  XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend
} from 'recharts'
import { format, subDays, eachDayOfInterval, isWeekend, parseISO } from 'date-fns'
import { Download, Filter, BarChart2, TrendingUp, ChevronDown, Check } from 'lucide-react'
import clsx from 'clsx'

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
    <div className={clsx('rounded-2xl p-4', colorMap[color])}>
      <p className="text-xs font-medium opacity-75">{label}</p>
      <p className="text-2xl font-bold mt-0.5">{value}</p>
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

export default function AnalyticsPage() {
  const { profile, hasRole } = useAuth()
  const dark = useIsDark()
  const isGlobal = hasRole('global_analytics')
  const isTeamAnalytics = hasRole('team_analytics') && !isGlobal

  const [employees, setEmployees] = useState([])
  const [projects,  setProjects]  = useState([])
  const [allData,   setAllData]   = useState([])

  const [startDate,   setStartDate]   = useState(format(subDays(new Date(), 30), 'yyyy-MM-dd'))
  const [endDate,     setEndDate]     = useState(format(new Date(), 'yyyy-MM-dd'))
  const [empFilters,  setEmpFilters]  = useState([])
  const [projFilters, setProjFilters] = useState([])
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    loadData()
  }, [startDate, endDate])

  async function loadData() {
    setLoading(true)
    const { data } = await supabase
      .from('timesheet_entries')
      .select(`
        id, project_name, task, time_from, time_to, hours_decimal,
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
      data.forEach(e => {
        const p = e.timesheets?.profiles
        if (p) uniqueEmps[p.id] = p
        if (e.project_name) uniqueProjs.add(e.project_name.trim())
      })
      setEmployees(Object.values(uniqueEmps).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')))
      setProjects([...uniqueProjs].sort())
    }
    setLoading(false)
  }

  const filtered = useMemo(() => {
    return allData.filter(e => {
      if (empFilters.length > 0 && !empFilters.includes(e.timesheets?.profiles?.id)) return false
      if (projFilters.length > 0 && !projFilters.includes((e.project_name || '').trim())) return false
      return true
    })
  }, [allData, empFilters, projFilters])

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
    const rows = [['Employee', 'Date', 'Project', 'Task', 'Time From', 'Time To', 'Hours']]
    filtered.forEach(e => {
      const p = e.timesheets?.profiles
      rows.push([
        p?.full_name || p?.email || '',
        e.timesheets?.date || '',
        e.project_name || '',
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 lg:pr-14">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Approved timesheets only</p>
        </div>
        <button onClick={downloadCSV} className="btn-secondary gap-2 text-sm">
          <Download size={15} /> Export CSV
        </button>
      </div>

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
        <div className="text-center py-20 text-gray-400">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          Loading data…
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
    </div>
  )
}
