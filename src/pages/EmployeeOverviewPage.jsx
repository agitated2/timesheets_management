import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  Users, Search, ChevronDown, ChevronRight, Briefcase, CalendarDays, Check, Layers,
} from 'lucide-react'
import Pagination from '../components/Pagination'
import EmployeeCalendarModal from '../components/EmployeeCalendarModal'
import clsx from 'clsx'
import { SkeletonList } from '../components/Skeleton'

const PAGE_SIZE = 10

// ── Inline allowance editor for one employee/category ─────────────
function AllowanceEditor({ employeeId, category, current, onSaved }) {
  const [value, setValue] = useState(current ?? '')
  const [saving, setSaving] = useState(false)
  const dirty = String(value) !== String(current ?? '')

  async function save() {
    if (value === '' ) return
    setSaving(true)
    const { error } = await supabase.rpc('set_leave_balance', {
      p_employees: [employeeId], p_category: category.id, p_allowance: Number(value),
    })
    setSaving(false)
    if (error) { alert(error.message); return }
    onSaved()
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number" min="0" step="0.5" value={value}
        onChange={e => setValue(e.target.value)}
        className="input text-sm w-20 py-1"
      />
      <button onClick={save} disabled={!dirty || saving} className="btn-primary text-xs px-2 py-1">
        <Check size={12} />
      </button>
    </div>
  )
}

// ── Inline discipline editor for one employee ─────────────────────
function DisciplineEditor({ employeeId, current, disciplines, onSaved }) {
  const [saving, setSaving] = useState(false)
  async function change(value) {
    setSaving(true)
    const { error } = await supabase.rpc('set_employee_discipline', {
      p_employees: [employeeId], p_discipline: value || null,
    })
    setSaving(false)
    if (error) { alert(error.message); return }
    onSaved()
  }
  return (
    <select
      value={current || ''} disabled={saving}
      onChange={e => change(e.target.value)}
      className="input text-sm w-full py-1 max-w-xs"
    >
      <option value="">— Unassigned —</option>
      {disciplines.map(d => (
        <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ' (inactive)'}</option>
      ))}
    </select>
  )
}

function EmployeeRow({ emp, projects, balances, calendarName, categories, disciplines, discName, canManage, onChanged, onOpenCalendar }) {
  const [open, setOpen] = useState(false)
  const balByCat = new Map(balances.map(b => [b.category_id, b]))

  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
        {open ? <ChevronDown size={15} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={15} className="text-gray-400 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{emp.full_name || emp.email}</p>
          <p className="text-xs text-gray-400 truncate">{emp.email}</p>
        </div>
        <span className="hidden lg:flex items-center gap-1 text-xs text-gray-500 max-w-[160px] truncate"><Layers size={12} className="flex-shrink-0" /> {discName || '—'}</span>
        <span className="hidden sm:flex items-center gap-1 text-xs text-gray-500"><Briefcase size={12} /> {projects.length}</span>
        <span className="hidden md:flex items-center gap-1 text-xs text-gray-500"><CalendarDays size={12} /> {calendarName}</span>
      </button>

      {open && (
        <div className="bg-gray-50 dark:bg-gray-800/40 border-t border-gray-100 dark:border-gray-800 px-5 py-4 grid md:grid-cols-3 gap-5">
          <div className="md:col-span-3 flex flex-wrap items-center gap-4">
            <button onClick={() => onOpenCalendar(emp)} className="btn-secondary text-sm">
              <CalendarDays size={14} /> Monthly calendar
            </button>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Discipline</span>
              {canManage ? (
                <DisciplineEditor employeeId={emp.id} current={emp.discipline_id} disciplines={disciplines} onSaved={onChanged} />
              ) : (
                <span className="text-sm">{discName || '—'}</span>
              )}
            </div>
          </div>
          {/* Projects */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Projects</p>
            {projects.length === 0 ? (
              <p className="text-xs text-gray-400">None assigned</p>
            ) : (
              <ul className="space-y-1">
                {projects.map((p, i) => <li key={i} className="text-sm">{p}</li>)}
              </ul>
            )}
          </div>

          {/* Leave balances */}
          <div className="md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Leave allowances (days)</p>
            <div className="space-y-1.5">
              {categories.filter(c => c.is_paid).map(c => {
                const b = balByCat.get(c.id)
                return (
                  <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-gray-500 tabular-nums">
                        {b ? `${Number(b.remaining)} left / ${Number(b.allowance)}` : '—'}
                      </span>
                      {canManage && (
                        <AllowanceEditor employeeId={emp.id} category={c} current={b ? Number(b.allowance) : ''} onSaved={onChanged} />
                      )}
                    </div>
                  </div>
                )
              })}
              {categories.filter(c => c.is_paid).length === 0 && (
                <p className="text-xs text-gray-400">No paid leave categories defined.</p>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-3">Calendar: <span className="text-gray-600 dark:text-gray-300">{calendarName}</span></p>
          </div>
        </div>
      )}
    </div>
  )
}

export default function EmployeeOverviewPage() {
  const { hasRole } = useAuth()
  const canManage = hasRole('hr_manage_policies') || hasRole('it')

  const [employees, setEmployees] = useState([])
  const [membersByEmp, setMembersByEmp] = useState({})
  const [balByEmp, setBalByEmp] = useState({})
  const [calByEmp, setCalByEmp] = useState({})
  const [defaultCal, setDefaultCal] = useState('Company Default')
  const [categories, setCategories] = useState([])
  const [disciplines, setDisciplines] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [calendarFor, setCalendarFor] = useState(null)

  const load = useCallback(async () => {
    const [profs, members, bals, assigns, cals, cats, disc] = await Promise.all([
      supabase.from('profiles').select('id, full_name, email, discipline_id').order('full_name'),
      supabase.from('project_members').select('employee_id, projects(name)'),
      supabase.from('leave_balance_summary').select('*'),
      supabase.from('calendar_assignments').select('employee_id, calendar_id'),
      supabase.from('holiday_calendars').select('id, name, is_default'),
      supabase.from('leave_categories').select('*').eq('is_active', true).order('name'),
      supabase.from('disciplines').select('id, name, is_active').order('name'),
    ])

    setEmployees(profs.data || [])
    setCategories(cats.data || [])
    setDisciplines(disc.data || [])

    const calNameById = new Map((cals.data || []).map(c => [c.id, c.name]))
    const def = (cals.data || []).find(c => c.is_default)
    setDefaultCal(def?.name || 'Company Default')

    const m = {}
    ;(members.data || []).forEach(r => {
      if (!m[r.employee_id]) m[r.employee_id] = []
      if (r.projects?.name) m[r.employee_id].push(r.projects.name)
    })
    setMembersByEmp(m)

    const b = {}
    ;(bals.data || []).forEach(r => {
      if (!b[r.employee_id]) b[r.employee_id] = []
      b[r.employee_id].push(r)
    })
    setBalByEmp(b)

    const c = {}
    ;(assigns.data || []).forEach(r => { c[r.employee_id] = calNameById.get(r.calendar_id) })
    setCalByEmp(c)

    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const discNameById = useMemo(() => new Map(disciplines.map(d => [d.id, d.name])), [disciplines])

  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => employees.filter(e =>
    !q || (e.full_name || '').toLowerCase().includes(q) || (e.email || '').toLowerCase().includes(q)
  ), [employees, q])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, totalPages)
  const shown = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Employee Overview</h1>
        <p className="page-subtitle">Everyone in the company — projects, leave allowances, and calendars.</p>
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} className="input pl-9" placeholder="Search by name or email…" />
      </div>

      <div className="card overflow-hidden">
        <div className="hidden sm:flex items-center gap-3 px-5 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
          <span className="w-[15px]" />
          <span className="flex-1">Employee</span>
          <span className="hidden lg:flex items-center gap-1 max-w-[160px]"><Layers size={12} /> Discipline</span>
          <span className="flex items-center gap-1"><Briefcase size={12} /> Projects</span>
          <span className="hidden md:flex items-center gap-1"><CalendarDays size={12} /> Calendar</span>
        </div>
        {loading ? (
          <SkeletonList rows={6} />
        ) : shown.length === 0 ? (
          <div className="text-center py-12">
            <Users size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No employees found.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {shown.map(emp => (
              <EmployeeRow
                key={emp.id}
                emp={emp}
                projects={membersByEmp[emp.id] || []}
                balances={balByEmp[emp.id] || []}
                calendarName={calByEmp[emp.id] || defaultCal}
                categories={categories}
                disciplines={disciplines}
                discName={discNameById.get(emp.discipline_id)}
                canManage={canManage}
                onChanged={load}
                onOpenCalendar={setCalendarFor}
              />
            ))}
          </div>
        )}
        <Pagination page={current} totalPages={totalPages} onChange={setPage} total={filtered.length} />
      </div>

      {calendarFor && (
        <EmployeeCalendarModal employee={calendarFor} onClose={() => setCalendarFor(null)} />
      )}
    </div>
  )
}
