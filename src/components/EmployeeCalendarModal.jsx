import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  X, ChevronLeft, ChevronRight, CheckCircle, Hourglass, XCircle,
  Plane, CalendarOff, AlertTriangle, ArrowUpRight,
} from 'lucide-react'
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
  addMonths, subMonths, format, isSameMonth, isToday, getDay, parseISO,
} from 'date-fns'
import clsx from 'clsx'
import { Skeleton } from './Skeleton'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// status → swatch + icon
const DAY_CFG = {
  approved: { dot: 'bg-emerald-500', cell: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900', icon: CheckCircle, text: 'text-emerald-600 dark:text-emerald-400' },
  pending:  { dot: 'bg-amber-500',   cell: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900',     icon: Hourglass,   text: 'text-amber-600 dark:text-amber-400' },
  rejected: { dot: 'bg-red-500',     cell: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900',           icon: XCircle,     text: 'text-red-600 dark:text-red-400' },
  leave:    { dot: 'bg-indigo-500',  cell: 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-900', icon: Plane,      text: 'text-indigo-600 dark:text-indigo-400' },
  holiday:  { dot: 'bg-purple-400',  cell: 'bg-purple-50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-900', icon: CalendarOff, text: 'text-purple-600 dark:text-purple-400' },
  missing:  { dot: 'bg-red-400',     cell: 'bg-red-50/60 dark:bg-red-950/10 border-red-200 dark:border-red-900/60',       icon: AlertTriangle, text: 'text-red-500' },
  weekend:  { dot: '',               cell: 'bg-gray-50 dark:bg-gray-800/40 border-gray-100 dark:border-gray-800',         icon: null,        text: 'text-gray-400' },
  empty:    { dot: '',               cell: 'border-gray-100 dark:border-gray-800',                                        icon: null,        text: 'text-gray-400' },
}

function StatPill({ label, value, color = 'gray' }) {
  const cls = {
    gray:    'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
    green:   'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300',
    amber:   'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300',
    red:     'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300',
    blue:    'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300',
  }[color]
  return (
    <div className={clsx('rounded-md px-3 py-2', cls)}>
      <p className="text-[10px] uppercase tracking-wide opacity-75">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

export default function EmployeeCalendarModal({ employee, onClose }) {
  const navigate = useNavigate()
  const [month, setMonth]   = useState(startOfMonth(new Date()))
  const [loading, setLoading] = useState(true)
  const [sheets, setSheets] = useState({})     // iso -> { id, status, total_hours }
  const [leaveDays, setLeaveDays] = useState(new Set())
  const [holidays, setHolidays] = useState({}) // iso -> name
  const [weekendDays, setWeekendDays] = useState([5, 6])

  const monthStart = month
  const monthEnd   = endOfMonth(month)
  const startISO   = format(monthStart, 'yyyy-MM-dd')
  const endISO     = format(monthEnd, 'yyyy-MM-dd')
  const todayISO   = format(new Date(), 'yyyy-MM-dd')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [{ data: ts }, { data: leaves }, { data: assign }, { data: cals }] = await Promise.all([
        supabase.from('timesheets').select('id, date, status, total_hours').eq('employee_id', employee.id).gte('date', startISO).lte('date', endISO),
        supabase.from('leave_requests').select('unit, start_date, end_date').eq('employee_id', employee.id).eq('status', 'approved').lte('start_date', endISO).gte('end_date', startISO),
        supabase.from('calendar_assignments').select('calendar_id').eq('employee_id', employee.id).maybeSingle(),
        supabase.from('holiday_calendars').select('id, weekend_days, is_default'),
      ])
      if (cancelled) return

      const sheetMap = {}
      ;(ts || []).forEach(t => { sheetMap[t.date] = t })

      const lDays = new Set()
      ;(leaves || []).forEach(l => {
        const a = parseISO(l.start_date), b = parseISO(l.end_date)
        eachDayOfInterval({ start: a, end: b }).forEach(d => lDays.add(format(d, 'yyyy-MM-dd')))
      })

      const calId = assign?.calendar_id || (cals || []).find(c => c.is_default)?.id || null
      const cal   = (cals || []).find(c => c.id === calId)
      setWeekendDays(cal?.weekend_days || [5, 6])

      let holMap = {}
      if (calId) {
        const { data: hol } = await supabase
          .from('public_holidays').select('date, name').eq('calendar_id', calId).gte('date', startISO).lte('date', endISO)
        if (!cancelled) (hol || []).forEach(h => { holMap[h.date] = h.name || 'Holiday' })
      }

      if (cancelled) return
      setSheets(sheetMap)
      setLeaveDays(lDays)
      setHolidays(holMap)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [employee.id, startISO, endISO])

  // Classify a date → { status, sheet, holidayName }
  function classify(iso, inMonth) {
    const sheet = sheets[iso]
    if (sheet) return { status: sheet.status, sheet }
    if (leaveDays.has(iso)) return { status: 'leave' }
    if (holidays[iso]) return { status: 'holiday', holidayName: holidays[iso] }
    const dow = getDay(parseISO(iso))
    if (weekendDays.includes(dow)) return { status: 'weekend' }
    // working day with no entry
    if (inMonth && iso <= todayISO) return { status: 'missing' }
    return { status: 'empty' }
  }

  const stats = useMemo(() => {
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd })
    let approved = 0, pending = 0, rejected = 0, hours = 0, missed = 0
    days.forEach(d => {
      const iso = format(d, 'yyyy-MM-dd')
      const { status, sheet } = classify(iso, true)
      if (status === 'approved') { approved++; hours += Number(sheet.total_hours || 0) }
      else if (status === 'pending')  pending++
      else if (status === 'rejected') rejected++
      else if (status === 'missing')  missed++
    })
    return { approved, pending, rejected, hours: Math.round(hours * 100) / 100, missed }
  }, [sheets, leaveDays, holidays, weekendDays, monthStart, monthEnd]) // eslint-disable-line react-hooks/exhaustive-deps

  const grid = eachDayOfInterval({
    start: startOfWeek(monthStart, { weekStartsOn: 0 }),
    end:   endOfWeek(monthEnd, { weekStartsOn: 0 }),
  })

  function openDay(sheet) {
    if (!sheet?.id) return
    onClose()
    navigate(`/review/${sheet.id}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm truncate">{employee.full_name || employee.email}</h2>
            <p className="text-xs text-gray-400">Timesheet calendar</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setMonth(m => subMonths(m, 1))} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"><ChevronLeft size={16} /></button>
            <span className="text-sm font-medium w-32 text-center tabular-nums">{format(month, 'MMMM yyyy')}</span>
            <button onClick={() => setMonth(m => addMonths(m, 1))} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"><ChevronRight size={16} /></button>
            <button onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 ml-1"><X size={18} /></button>
          </div>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            <StatPill label="Approved" value={stats.approved} color="green" />
            <StatPill label="Pending"  value={stats.pending}  color="amber" />
            <StatPill label="Rejected" value={stats.rejected} color="red" />
            <StatPill label="Hours"    value={`${stats.hours}h`} color="blue" />
            <StatPill label="Missed"   value={stats.missed}   color={stats.missed > 0 ? 'red' : 'green'} />
          </div>

          {loading ? (
            <div className="py-4"><Skeleton className="h-64 w-full" /></div>
          ) : (
            <>
              {/* Grid */}
              <div className="grid grid-cols-7 gap-1">
                {WEEKDAYS.map((w, i) => (
                  <div key={w} className={clsx('text-center text-[10px] font-semibold uppercase tracking-wide py-1', weekendDays.includes(i) ? 'text-gray-400' : 'text-gray-500')}>{w}</div>
                ))}
                {grid.map(day => {
                  const iso = format(day, 'yyyy-MM-dd')
                  const inMonth = isSameMonth(day, monthStart)
                  const { status, sheet, holidayName } = classify(iso, inMonth)
                  const cfg = DAY_CFG[status] || DAY_CFG.empty
                  const Icon = cfg.icon
                  const clickable = !!sheet?.id
                  return (
                    <button
                      key={iso}
                      onClick={() => clickable && openDay(sheet)}
                      disabled={!clickable}
                      title={holidayName || (sheet ? `${status} · ${sheet.total_hours ?? 0}h` : status)}
                      className={clsx(
                        'relative h-16 rounded-md border p-1.5 text-left transition-colors',
                        cfg.cell,
                        !inMonth && 'opacity-40',
                        clickable ? 'cursor-pointer hover:ring-1 hover:ring-ae7-red' : 'cursor-default'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className={clsx('text-xs font-medium', isToday(day) && 'bg-ae7-red text-white rounded-full w-5 h-5 inline-flex items-center justify-center')}>
                          {format(day, 'd')}
                        </span>
                        {Icon && <Icon size={12} className={cfg.text} />}
                      </div>
                      {sheet && (
                        <span className={clsx('absolute bottom-1.5 left-1.5 text-[11px] font-semibold tabular-nums', cfg.text)}>
                          {sheet.total_hours ?? 0}h
                        </span>
                      )}
                      {status === 'holiday' && <span className="absolute bottom-1 left-1.5 right-1.5 text-[9px] truncate text-purple-500">{holidayName}</span>}
                      {clickable && <ArrowUpRight size={10} className="absolute bottom-1.5 right-1.5 text-gray-400" />}
                    </button>
                  )
                })}
              </div>

              {/* Legend */}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-gray-500 pt-1">
                {[['approved', 'Approved'], ['pending', 'Pending'], ['rejected', 'Rejected'], ['leave', 'Leave'], ['holiday', 'Holiday'], ['missing', 'Missed'], ['weekend', 'Weekend']].map(([k, lbl]) => (
                  <span key={k} className="inline-flex items-center gap-1.5">
                    <span className={clsx('w-2.5 h-2.5 rounded-full', DAY_CFG[k].dot || 'bg-gray-300 dark:bg-gray-600')} /> {lbl}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
