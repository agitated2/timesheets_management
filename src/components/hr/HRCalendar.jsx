import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { CalendarDays, Plus, Trash2, Check, Users } from 'lucide-react'
import MultiSelect from '../MultiSelect'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'

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

  if (loading) return <div className="card p-12 text-center text-sm text-gray-400">Loading…</div>

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
            <button key={c.id} onClick={() => setSelectedId(c.id)}
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
                      on ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-gray-900 dark:border-gray-100'
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
        </div>
      )}
    </div>
  )
}
