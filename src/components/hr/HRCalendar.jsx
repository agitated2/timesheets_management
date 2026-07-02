import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { CalendarDays, Plus, Trash2, Check, Users, X } from 'lucide-react'
import MultiSelect from '../MultiSelect'
import Pagination from '../Pagination'
import { format, parseISO } from 'date-fns'
import { Skeleton } from '../Skeleton'
import clsx from 'clsx'

const ASSIGN_PAGE_SIZE = 10

const DOW = [['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]]

export default function HRCalendar() {
  const [calendars, setCalendars] = useState([])
  const [holidays, setHolidays]   = useState([])
  const [employees, setEmployees] = useState([])
  const [assignments, setAssignments] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading]     = useState(true)

  const [newCalName, setNewCalName] = useState('')
  const [holDate, setHolDate]       = useState('')
  const [holName, setHolName]       = useState('')
  const [assignEmps, setAssignEmps] = useState([])
  const [assignMsg, setAssignMsg]   = useState('')
  const [assignPage, setAssignPage] = useState(1)

  const load = useCallback(async () => {
    const [cals, profs, assigns] = await Promise.all([
      supabase.from('holiday_calendars').select('*').order('is_default', { ascending: false }).order('name'),
      supabase.from('profiles').select('id, full_name, email').order('full_name'),
      supabase.from('calendar_assignments').select('employee_id, calendar_id'),
    ])
    setCalendars(cals.data || [])
    setEmployees(profs.data || [])
    setAssignments(assigns.data || [])
    setSelectedId(prev => prev || cals.data?.[0]?.id || null)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!selectedId) return
    supabase.from('public_holidays').select('*').eq('calendar_id', selectedId).order('date')
      .then(({ data }) => setHolidays(data || []))
  }, [selectedId])

  const selected = calendars.find(c => c.id === selectedId)
  const employeeOptions = useMemo(
    () => employees.map(e => ({ value: e.id, label: e.full_name || e.email, sublabel: e.email })),
    [employees]
  )
  const assignedCount = selectedId ? assignments.filter(a => a.calendar_id === selectedId).length : 0

  async function addCalendar(e) {
    e.preventDefault()
    const { data, error } = await supabase.from('holiday_calendars')
      .insert({ name: newCalName.trim(), weekend_days: [5, 6] }).select().single()
    if (error) { alert(error.message); return }
    setNewCalName('')
    await load()
    if (data) setSelectedId(data.id)
  }

  async function toggleWeekend(dow) {
    if (!selected) return
    const set = new Set(selected.weekend_days)
    set.has(dow) ? set.delete(dow) : set.add(dow)
    const next = [...set].sort((a, b) => a - b)
    await supabase.from('holiday_calendars').update({ weekend_days: next }).eq('id', selected.id)
    load()
  }

  async function addHoliday(e) {
    e.preventDefault()
    if (!holDate || !selectedId) return
    const { error } = await supabase.from('public_holidays')
      .insert({ calendar_id: selectedId, date: holDate, name: holName.trim() || null })
    if (error) { alert(error.message); return }
    setHolDate(''); setHolName('')
    const { data } = await supabase.from('public_holidays').select('*').eq('calendar_id', selectedId).order('date')
    setHolidays(data || [])
  }

  async function removeHoliday(id) {
    await supabase.from('public_holidays').delete().eq('id', id)
    setHolidays(prev => prev.filter(h => h.id !== id))
  }

  async function assign(e) {
    e.preventDefault()
    setAssignMsg('')
    if (!selectedId || assignEmps.length === 0) return
    const { error } = await supabase.rpc('assign_calendar', { p_employees: assignEmps, p_calendar: selectedId })
    if (error) { setAssignMsg(error.message); return }
    setAssignMsg(`Assigned ${assignEmps.length} employee${assignEmps.length === 1 ? '' : 's'}.`)
    setAssignEmps([])
    load()
  }

  // Remove an explicit assignment → employee falls back to the default calendar.
  async function unassign(empId) {
    const { error } = await supabase.from('calendar_assignments').delete().eq('employee_id', empId)
    if (error) { alert(error.message); return }
    load()
  }

  // Employees on the selected calendar. The default calendar implicitly holds
  // everyone without an explicit assignment elsewhere.
  const assignedHere = useMemo(() => {
    if (!selected) return []
    return employees.filter(e => {
      const a = assignments.find(x => x.employee_id === e.id)
      return selected.is_default ? (!a || a.calendar_id === selected.id) : (a && a.calendar_id === selected.id)
    })
  }, [employees, assignments, selected])

  const assignTotalPages = Math.max(1, Math.ceil(assignedHere.length / ASSIGN_PAGE_SIZE))
  const assignCurrent    = Math.min(assignPage, assignTotalPages)
  const assignShown      = assignedHere.slice((assignCurrent - 1) * ASSIGN_PAGE_SIZE, assignCurrent * ASSIGN_PAGE_SIZE)

  if (loading) return <div className="card p-6"><Skeleton className="h-72 w-full" /></div>

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      {/* Calendar list */}
      <div className="card overflow-hidden h-fit">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
          <CalendarDays size={15} className="text-gray-400" />
          <h2 className="font-semibold text-sm">Calendars</h2>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {calendars.map(c => (
            <button key={c.id} onClick={() => { setSelectedId(c.id); setAssignPage(1) }}
              className={clsx('w-full text-left px-5 py-3 text-sm transition-colors',
                selectedId === c.id ? 'bg-gray-100 dark:bg-gray-800 font-medium' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50')}>
              {c.name}
              {c.is_default && <span className="text-xs text-gray-400 ml-2">default</span>}
            </button>
          ))}
        </div>
        <form onSubmit={addCalendar} className="px-5 py-4 border-t border-gray-100 dark:border-gray-800 flex gap-2">
          <input value={newCalName} onChange={e => setNewCalName(e.target.value)} placeholder="New calendar" className="input text-sm" required />
          <button type="submit" disabled={!newCalName.trim()} className="btn-primary text-sm flex-shrink-0"><Plus size={14} /></button>
        </form>
      </div>

      {/* Selected calendar details */}
      {selected && (
        <div className="lg:col-span-2 space-y-6">
          {/* Weekend days */}
          <div className="card p-5">
            <h3 className="font-semibold text-sm mb-1">Weekend days — {selected.name}</h3>
            <p className="text-xs text-gray-400 mb-3">Timesheets stay open on these days for overtime; leave isn't deducted.</p>
            <div className="flex gap-1.5 flex-wrap">
              {DOW.map(([label, dow]) => {
                const on = selected.weekend_days.includes(dow)
                return (
                  <button key={dow} onClick={() => toggleWeekend(dow)}
                    className={clsx('px-3 py-2 rounded-md text-sm font-medium border transition-colors',
                      on ? 'bg-ae7-red text-white border-ae7-red'
                         : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800')}>
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Holidays */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-semibold text-sm">Public holidays</h3>
            </div>
            <form onSubmit={addHoliday} className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row gap-2">
              <input type="date" value={holDate} onChange={e => setHolDate(e.target.value)} className="input text-sm" required />
              <input value={holName} onChange={e => setHolName(e.target.value)} placeholder="Name (optional)" className="input text-sm" />
              <button type="submit" disabled={!holDate} className="btn-primary text-sm flex-shrink-0"><Plus size={14} /> Add</button>
            </form>
            <div className="divide-y divide-gray-100 dark:divide-gray-800 max-h-64 overflow-y-auto">
              {holidays.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No holidays added.</p>
              ) : holidays.map(h => (
                <div key={h.id} className="flex items-center justify-between px-5 py-2.5">
                  <span className="text-sm">{format(parseISO(h.date), 'EEE, MMM d, yyyy')}{h.name && <span className="text-gray-400 ml-2">· {h.name}</span>}</span>
                  <button onClick={() => removeHoliday(h.id)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </div>

          {/* Assign employees */}
          <div className="card p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Users size={15} className="text-gray-400" />
              <h3 className="font-semibold text-sm">Assign employees</h3>
              <span className="text-xs text-gray-400">{assignedCount} currently assigned</span>
            </div>
            <form onSubmit={assign} className="flex flex-col sm:flex-row gap-2">
              <div className="flex-1">
                <MultiSelect options={employeeOptions} value={assignEmps} onChange={setAssignEmps} placeholder="Select employees…" />
              </div>
              <button type="submit" disabled={assignEmps.length === 0} className="btn-primary text-sm flex-shrink-0">
                <Check size={14} /> Assign to {selected.name}
              </button>
            </form>
            {assignMsg && <p className={clsx('text-xs', assignMsg.includes('Assigned') ? 'text-emerald-600' : 'text-red-500')}>{assignMsg}</p>}
          </div>

          {/* Employees on this calendar */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
              <Users size={15} className="text-gray-400" />
              <h3 className="font-semibold text-sm">Employees on {selected.name}</h3>
              <span className="text-xs text-gray-400">{assignedHere.length}</span>
            </div>
            {assignedHere.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">No employees on this calendar.</p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {assignShown.map(e => {
                  const explicit = assignments.some(a => a.employee_id === e.id && a.calendar_id === selected.id)
                  return (
                    <div key={e.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm truncate">{e.full_name || e.email}</p>
                        {selected.is_default && !explicit && <p className="text-xs text-gray-400">default (unassigned)</p>}
                      </div>
                      {!selected.is_default && (
                        <button onClick={() => unassign(e.id)} title="Move back to default calendar"
                          className="text-xs text-gray-500 hover:text-red-500 flex items-center gap-1">
                          <X size={12} /> Unassign
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <Pagination page={assignCurrent} totalPages={assignTotalPages} onChange={setAssignPage} total={assignedHere.length} />
          </div>
        </div>
      )}
    </div>
  )
}
