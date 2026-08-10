import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  Users, Search, Eye, CalendarDays, Check, Layers, Plus, Minus, Building2,
} from 'lucide-react'
import Pagination from '../components/Pagination'
import EmployeeCalendarModal from '../components/EmployeeCalendarModal'
import Modal from '../components/Modal'
import MultiSelect from '../components/MultiSelect'
import clsx from 'clsx'
import { format, parseISO } from 'date-fns'
import { SkeletonList } from '../components/Skeleton'

const PAGE_SIZE = 10

// ── Inline increment/decrement editor for one employee/category ───
// Adjusts the existing balance by a delta — the caller never needs to know
// the employee's current running total. Absolute corrections still go
// through the mass "Set allowances" form on the Policies tab.
function AllowanceEditor({ employeeId, category, onSaved }) {
  const [delta, setDelta] = useState('')
  const [saving, setSaving] = useState(false)
  const n = Number(delta)
  const canApply = delta !== '' && n > 0 && !saving

  async function apply(sign) {
    if (!canApply) return
    setSaving(true)
    const { error } = await supabase.rpc('adjust_leave_balance', {
      p_employees: [employeeId], p_category: category.id, p_delta: sign * n,
    })
    setSaving(false)
    if (error) { alert(error.message); return }
    setDelta('')
    onSaved()
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => apply(-1)} disabled={!canApply} title="Subtract"
        className="p-1 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent transition-colors"
      >
        <Minus size={13} />
      </button>
      <input
        type="number" min="0" step="0.5" value={delta}
        onChange={e => setDelta(e.target.value)}
        placeholder="0" className="input text-sm w-14 py-1 text-center"
      />
      <button
        onClick={() => apply(1)} disabled={!canApply} title="Add"
        className="p-1 rounded-md text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent transition-colors"
      >
        <Plus size={13} />
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

// ── Inline joining-date editor for one employee ────────────────────
// Drives the anniversary-based leave cycle (see HR Policies) — changing
// this changes when that employee's leave balance next resets.
function JoiningDateEditor({ employeeId, current, onSaved }) {
  const [value, setValue] = useState(current || '')
  const [saving, setSaving] = useState(false)

  async function save(next) {
    setSaving(true)
    const { error } = await supabase.rpc('set_joining_date', { p_employees: [employeeId], p_date: next || null })
    setSaving(false)
    if (error) { alert(error.message); return }
    onSaved()
  }

  return (
    <input
      type="date" value={value} disabled={saving}
      onChange={e => { setValue(e.target.value); save(e.target.value) }}
      className="input text-sm py-1 max-w-[160px]"
    />
  )
}

function EmployeeRow({ emp, discName, officeName, onOpenDetail, onOpenCalendar }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{emp.full_name || emp.email}</p>
        <p className="text-xs text-gray-400 truncate">{emp.email}</p>
      </div>
      <span className="hidden sm:flex items-center gap-1 text-xs text-gray-500 max-w-[160px] truncate"><Layers size={12} className="flex-shrink-0" /> {discName || '—'}</span>
      <span className="hidden md:flex items-center gap-1 text-xs text-gray-500 max-w-[140px] truncate"><Building2 size={12} className="flex-shrink-0" /> {officeName || '—'}</span>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => onOpenDetail(emp)} title="View details"
          className="p-1.5 rounded-lg text-gray-400 hover:text-ae7-red hover:bg-ae7-light dark:hover:bg-ae7-red/10 transition-colors"
        >
          <Eye size={15} />
        </button>
        <button
          onClick={() => onOpenCalendar(emp)} title="Monthly calendar"
          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors"
        >
          <CalendarDays size={15} />
        </button>
      </div>
    </div>
  )
}

// ── Detail modal: everything that used to be inline in the accordion ──
function EmployeeDetailModal({ emp, projects, balances, calendarName, officeName, categories, disciplines, discName, canManage, onChanged, onClose }) {
  const balByCat = new Map(balances.map(b => [b.category_id, b]))
  // Categories are per-office now — only show the employee's own office's
  // categories, not every office the viewer (e.g. an IT admin) can see.
  const paidCategories = categories.filter(c => c.is_paid && c.office_id === emp.office_id)

  return (
    <Modal
      title={emp.full_name || emp.email}
      icon={<Users size={16} className="text-ae7-red" />}
      onClose={onClose}
      wide
    >
      <div className="p-6 space-y-5">
        <p className="text-xs text-gray-400 -mt-3">{emp.email}</p>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Discipline</span>
            {canManage ? (
              <DisciplineEditor employeeId={emp.id} current={emp.discipline_id} disciplines={disciplines} onSaved={onChanged} />
            ) : (
              <span className="text-sm">{discName || '—'}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Joining date</span>
            {canManage ? (
              <JoiningDateEditor employeeId={emp.id} current={emp.joining_date} onSaved={onChanged} />
            ) : (
              <span className="text-sm">{emp.joining_date ? format(parseISO(emp.joining_date), 'MMM d, yyyy') : '—'}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Office</span>
            <span className="text-sm">{officeName || '—'}</span>
            {canManage && <span className="text-xs text-gray-400">(change in IT Panel → Offices)</span>}
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
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Leave allowances (days)</p>
          <div className="space-y-1.5">
            {paidCategories.map(c => {
              const b = balByCat.get(c.id)
              return (
                <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{c.name}</span>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {b ? (
                      <span className="text-xs text-right leading-tight">
                        <span className="block text-gray-700 dark:text-gray-300 tabular-nums font-medium">{Number(b.remaining)} available</span>
                        <span className="block text-gray-400 tabular-nums">{Number(b.used)} taken · {Number(b.allowance)} total</span>
                      </span>
                    ) : (
                      <span className="text-gray-500 text-xs">—</span>
                    )}
                    {canManage && (
                      <AllowanceEditor employeeId={emp.id} category={c} onSaved={onChanged} />
                    )}
                  </div>
                </div>
              )
            })}
            {paidCategories.length === 0 && (
              <p className="text-xs text-gray-400">No paid leave categories defined.</p>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-3">Calendar: <span className="text-gray-600 dark:text-gray-300">{calendarName}</span></p>
        </div>
      </div>
    </Modal>
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
  const [offices, setOffices] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [officeFilter, setOfficeFilter] = useState([])
  const [page, setPage] = useState(1)
  const [calendarFor, setCalendarFor] = useState(null)
  const [detailFor, setDetailFor] = useState(null)

  const load = useCallback(async () => {
    const [profs, members, bals, cals, offs, cats, disc] = await Promise.all([
      supabase.from('profiles').select('id, full_name, email, discipline_id, joining_date, office_id').order('full_name'),
      supabase.from('project_members').select('employee_id, projects(name)'),
      supabase.from('leave_balance_summary').select('*'),
      // Calendars are tied 1:1 to an office now (see migration_v10); resolved
      // below via each employee's office_id, matching emp_calendar() server-side.
      supabase.from('holiday_calendars').select('id, name, is_default, office_id'),
      supabase.from('offices').select('id, name').order('name'),
      supabase.from('leave_categories').select('*').eq('is_active', true).order('name'),
      supabase.from('disciplines').select('id, name, is_active').order('name'),
    ])

    setEmployees(profs.data || [])
    setCategories(cats.data || [])
    setDisciplines(disc.data || [])
    setOffices(offs.data || [])

    const calByOffice = new Map((cals.data || []).filter(c => c.office_id).map(c => [c.office_id, c.name]))
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
    ;(profs.data || []).forEach(e => { c[e.id] = calByOffice.get(e.office_id) || def?.name || 'Company Default' })
    setCalByEmp(c)

    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const discNameById = useMemo(() => new Map(disciplines.map(d => [d.id, d.name])), [disciplines])
  const officeNameById = useMemo(() => new Map(offices.map(o => [o.id, o.name])), [offices])

  // Options are just whichever offices the (already RLS-scoped) employee
  // list actually references — no separate visibility check needed, and
  // no dead options that would only ever filter to zero rows.
  const officeFilterOptions = useMemo(() => {
    const usedIds = new Set(employees.map(e => e.office_id))
    return offices.filter(o => usedIds.has(o.id)).map(o => ({ value: o.id, label: o.name }))
  }, [offices, employees])

  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => employees.filter(e => {
    if (officeFilter.length && !officeFilter.includes(e.office_id)) return false
    return !q || (e.full_name || '').toLowerCase().includes(q) || (e.email || '').toLowerCase().includes(q)
  }), [employees, q, officeFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, totalPages)
  const shown = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  // Looked up live (rather than snapshotting the row at open time) so inline
  // edits inside the modal — discipline, joining date, balances — reflect
  // immediately after `load()` re-runs.
  const detailEmp = detailFor ? employees.find(e => e.id === detailFor) : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Employee Overview</h1>
        <p className="page-subtitle">Everyone in the company — projects, leave allowances, and calendars.</p>
      </div>

      <div className={clsx('grid gap-3', officeFilterOptions.length > 1 ? 'sm:grid-cols-[1fr_260px]' : '')}>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} className="input pl-9" placeholder="Search by name or email…" />
        </div>
        {officeFilterOptions.length > 1 && (
          <MultiSelect
            options={officeFilterOptions}
            value={officeFilter}
            onChange={v => { setOfficeFilter(v); setPage(1) }}
            placeholder="All offices"
          />
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="hidden sm:flex items-center gap-3 px-5 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
          <span className="flex-1">Employee</span>
          <span className="hidden sm:flex items-center gap-1 max-w-[160px]"><Layers size={12} /> Discipline</span>
          <span className="hidden md:flex items-center gap-1 max-w-[140px]"><Building2 size={12} /> Office</span>
          <span className="w-[62px] text-right">Actions</span>
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
                discName={discNameById.get(emp.discipline_id)}
                officeName={officeNameById.get(emp.office_id)}
                onOpenDetail={e => setDetailFor(e.id)}
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

      {detailEmp && (
        <EmployeeDetailModal
          emp={detailEmp}
          projects={membersByEmp[detailEmp.id] || []}
          balances={balByEmp[detailEmp.id] || []}
          calendarName={calByEmp[detailEmp.id] || defaultCal}
          officeName={officeNameById.get(detailEmp.office_id)}
          categories={categories}
          disciplines={disciplines}
          discName={discNameById.get(detailEmp.discipline_id)}
          canManage={canManage}
          onChanged={load}
          onClose={() => setDetailFor(null)}
        />
      )}
    </div>
  )
}
