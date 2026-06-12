import { useEffect, useState, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  Briefcase, Plus, Search, ChevronDown, ChevronUp, Calendar,
  Users, Pencil, Check, X, AlertTriangle, ChevronLeft,
  ChevronRight, ScrollText, CalendarDays, Download, Archive,
  UserPlus, Trash2, FolderPlus,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'

const PAGE_SIZE = 10

const changeTypeLabel = {
  create:       'Stage Created',
  define_start: 'Start Date Defined',
  define_end:   'End Date Defined',
  define_both:  'Dates Defined',
  extend_end:   'End Date Extended',
}

function getStageDateState(stage) {
  const s = !!stage.start_date
  const e = !!stage.end_date
  if (!s && !e) return 'none'
  if (s && !e)  return 'start_only'
  if (!s && e)  return 'end_only'
  return 'both'
}

function formatDate(d) {
  return d ? format(parseISO(d), 'dd MMM yyyy') : null
}

function getPageNums(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const set = new Set([1, total, current, current - 1, current + 1].filter(p => p >= 1 && p <= total))
  const sorted = [...set].sort((a, b) => a - b)
  const result = []
  let prev = 0
  for (const p of sorted) {
    if (p - prev > 1) result.push('...')
    result.push(p)
    prev = p
  }
  return result
}

function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null
  const pages = getPageNums(page, totalPages)
  return (
    <div className="flex items-center justify-center gap-1 py-2">
      <button onClick={() => onChange(page - 1)} disabled={page === 1} className="p-2 rounded-xl text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
        <ChevronLeft size={16} />
      </button>
      {pages.map((p, i) => p === '...' ? (
        <span key={`e${i}`} className="w-9 text-center text-sm text-gray-400">…</span>
      ) : (
        <button key={p} onClick={() => onChange(p)} className={clsx('w-9 h-9 rounded-xl text-sm font-medium transition-colors', p === page ? 'bg-ae7-red text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800')}>
          {p}
        </button>
      ))}
      <button onClick={() => onChange(page + 1)} disabled={page === totalPages} className="p-2 rounded-xl text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

function Modal({ title, icon, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className={clsx('bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full flex flex-col max-h-[90vh]', wide ? 'max-w-2xl' : 'max-w-md')}>
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">{icon}<h3 className="font-semibold text-sm">{title}</h3></div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  )
}

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="label">{label}</label>
      {hint && <p className="text-xs text-gray-400 mb-1">{hint}</p>}
      {children}
    </div>
  )
}

function ErrorBox({ msg }) {
  if (!msg) return null
  return (
    <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
      {msg}
    </div>
  )
}

// ── Create Project Modal ─────────────────────────────────────────
function CreateProjectModal({ onClose, onCreated }) {
  const { profile } = useAuth()
  const [name, setName]         = useState('')
  const [desc, setDesc]         = useState('')
  const [stageName, setStageName] = useState('Phase 1')
  const [startDate, setStart]   = useState('')
  const [endDate, setEnd]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  async function handleCreate(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Project name is required.'); return }
    setLoading(true)

    const { data: proj, error: projErr } = await supabase
      .from('projects')
      .insert({ name: name.trim(), description: desc.trim() || null, created_by: profile.id })
      .select()
      .single()
    if (projErr) { setError(projErr.message); setLoading(false); return }

    const { data: stage, error: stageErr } = await supabase
      .from('project_stages')
      .insert({
        project_id: proj.id,
        name: stageName.trim() || 'Phase 1',
        start_date: startDate || null,
        end_date: endDate || null,
        order_index: 0,
        created_by: profile.id,
      })
      .select()
      .single()
    if (stageErr) { setError(stageErr.message); setLoading(false); return }

    await supabase.from('project_stage_logs').insert({
      stage_id: stage.id, project_id: proj.id, changed_by: profile.id,
      change_type: 'create',
      new_start: startDate || null, new_end: endDate || null,
    })

    setLoading(false)
    onCreated()
    onClose()
  }

  return (
    <Modal title="New project" icon={<FolderPlus size={16} className="text-ae7-red" />} onClose={onClose}>
      <form onSubmit={handleCreate} className="p-6 space-y-4">
        <Field label="Project name *">
          <input type="text" value={name} onChange={e => setName(e.target.value)} className="input" placeholder="e.g. Al Wasl Tower" required autoFocus />
        </Field>
        <Field label="Description">
          <textarea value={desc} onChange={e => setDesc(e.target.value)} className="input min-h-[70px] resize-none" placeholder="Optional project description" />
        </Field>
        <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">First stage</p>
          <div className="space-y-3">
            <Field label="Stage name">
              <input type="text" value={stageName} onChange={e => setStageName(e.target.value)} className="input" placeholder="Phase 1" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date"><input type="date" value={startDate} onChange={e => setStart(e.target.value)} className="input text-sm" /></Field>
              <Field label="End date"><input type="date" value={endDate} min={startDate || undefined} onChange={e => setEnd(e.target.value)} className="input text-sm" /></Field>
            </div>
            <p className="text-xs text-gray-400">Dates are optional — you can define or extend them later.</p>
          </div>
        </div>
        <ErrorBox msg={error} />
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={loading} className="btn-primary flex-1">
            {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><FolderPlus size={15} /> Create project</>}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Add Stage Modal ──────────────────────────────────────────────
function AddStageModal({ project, onClose, onCreated }) {
  const { profile } = useAuth()
  const [name, setName]       = useState('')
  const [startDate, setStart] = useState('')
  const [endDate, setEnd]     = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const nextIndex = (project.project_stages?.length || 0)

  async function handleAdd(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Stage name is required.'); return }
    setLoading(true)

    const { data: stage, error: stageErr } = await supabase
      .from('project_stages')
      .insert({
        project_id: project.id, name: name.trim(),
        start_date: startDate || null, end_date: endDate || null,
        order_index: nextIndex, created_by: profile.id,
      })
      .select()
      .single()
    if (stageErr) { setError(stageErr.message); setLoading(false); return }

    await supabase.from('project_stage_logs').insert({
      stage_id: stage.id, project_id: project.id, changed_by: profile.id,
      change_type: 'create', new_start: startDate || null, new_end: endDate || null,
    })

    setLoading(false)
    onCreated()
    onClose()
  }

  return (
    <Modal title={`Add stage — ${project.name}`} icon={<CalendarDays size={15} className="text-ae7-red" />} onClose={onClose}>
      <form onSubmit={handleAdd} className="p-6 space-y-4">
        <Field label="Stage name *">
          <input type="text" value={name} onChange={e => setName(e.target.value)} className="input" placeholder="e.g. Construction Documents" required autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date"><input type="date" value={startDate} onChange={e => setStart(e.target.value)} className="input text-sm" /></Field>
          <Field label="End date"><input type="date" value={endDate} min={startDate || undefined} onChange={e => setEnd(e.target.value)} className="input text-sm" /></Field>
        </div>
        <p className="text-xs text-gray-400">Dates can be left undefined and set later.</p>
        <ErrorBox msg={error} />
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={loading} className="btn-primary flex-1">
            {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Plus size={15} /> Add stage</>}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Date Action Modal ────────────────────────────────────────────
// action: 'define_both' | 'define_start' | 'define_end' | 'extend_end'
function DateActionModal({ stage, project, action, onClose, onDone }) {
  const { profile } = useAuth()
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd]     = useState('')
  const [reason, setReason]     = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  const requiresReason = action === 'extend_end'
  const showStart = action === 'define_both' || action === 'define_start'
  const showEnd   = action === 'define_both' || action === 'define_end' || action === 'extend_end'

  const titles = {
    define_both:  'Define dates',
    define_start: 'Define start date',
    define_end:   'Define end date',
    extend_end:   'Extend end date',
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (requiresReason && !reason.trim()) { setError('A reason is required to extend a date.'); return }
    if (action === 'extend_end' && newEnd && newEnd <= stage.end_date) {
      setError(`New end date must be after the current end date (${formatDate(stage.end_date)}).`)
      return
    }
    if (action === 'define_both' && !newStart && !newEnd) { setError('Set at least one date.'); return }

    const updates = {}
    if (showStart && newStart) updates.start_date = newStart
    if (showEnd && newEnd) updates.end_date = newEnd

    if (Object.keys(updates).length === 0) { setError('Set at least one date.'); return }

    setLoading(true)
    const { error: upErr } = await supabase.from('project_stages').update(updates).eq('id', stage.id)
    if (upErr) { setError(upErr.message); setLoading(false); return }

    await supabase.from('project_stage_logs').insert({
      stage_id: stage.id, project_id: project.id, changed_by: profile.id,
      change_type: action,
      old_start: stage.start_date || null, new_start: updates.start_date ?? stage.start_date ?? null,
      old_end: stage.end_date || null, new_end: updates.end_date ?? stage.end_date ?? null,
      reason: reason.trim() || null,
    })

    setLoading(false)
    onDone()
    onClose()
  }

  return (
    <Modal title={`${titles[action]} — ${stage.name}`} icon={<Calendar size={15} className="text-ae7-red" />} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        {stage.start_date || stage.end_date ? (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl px-4 py-3 text-xs text-gray-500">
            Current: {formatDate(stage.start_date) || 'Not set'} → {formatDate(stage.end_date) || 'Not set'}
          </div>
        ) : null}

        {showStart && (
          <Field label="Start date" hint={action === 'define_both' ? 'Optional' : undefined}>
            <input type="date" value={newStart} onChange={e => setNewStart(e.target.value)} className="input" />
          </Field>
        )}
        {showEnd && (
          <Field
            label={action === 'extend_end' ? 'New end date *' : 'End date'}
            hint={action === 'extend_end' ? `Must be after ${formatDate(stage.end_date)}` : action === 'define_both' ? 'Optional' : undefined}
          >
            <input
              type="date"
              value={newEnd}
              min={action === 'extend_end' ? (stage.end_date || undefined) : undefined}
              onChange={e => setNewEnd(e.target.value)}
              className="input"
            />
          </Field>
        )}
        {requiresReason && (
          <Field label="Reason for extension *">
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              className="input min-h-[80px] resize-none"
              placeholder="e.g. Client requested additional design revisions"
              required
            />
          </Field>
        )}
        {!requiresReason && (
          <p className="text-xs text-gray-400">This change will be logged automatically.</p>
        )}
        <ErrorBox msg={error} />
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={loading} className="btn-primary flex-1">
            {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Check size={15} /> {titles[action]}</>}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Manage Members Modal ─────────────────────────────────────────
function ManageMembersModal({ project, onClose, onSaved }) {
  const { profile: self } = useAuth()
  const [allProfiles, setAllProfiles] = useState([])
  const [memberIds, setMemberIds]     = useState(new Set((project.project_members || []).map(m => m.employee_id)))
  const [search, setSearch]           = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  useEffect(() => {
    supabase.from('profiles').select('id, full_name, email').order('full_name')
      .then(({ data }) => { if (data) setAllProfiles(data) })
  }, [])

  const filtered = allProfiles.filter(p => {
    if (!search) return true
    const q = search.toLowerCase()
    return (p.full_name || '').toLowerCase().includes(q) || p.email.toLowerCase().includes(q)
  })

  async function handleSave() {
    setSaving(true)
    const original = new Set((project.project_members || []).map(m => m.employee_id))
    const toAdd    = [...memberIds].filter(id => !original.has(id))
    const toRemove = [...original].filter(id => !memberIds.has(id))

    if (toAdd.length > 0) {
      const { error: addErr } = await supabase.from('project_members').insert(
        toAdd.map(id => ({ project_id: project.id, employee_id: id, assigned_by: self.id }))
      )
      if (addErr) { setError(addErr.message); setSaving(false); return }
    }
    if (toRemove.length > 0) {
      const { error: rmErr } = await supabase.from('project_members')
        .delete()
        .eq('project_id', project.id)
        .in('employee_id', toRemove)
      if (rmErr) { setError(rmErr.message); setSaving(false); return }
    }

    setSaving(false)
    onSaved()
    onClose()
  }

  function toggle(id) {
    setMemberIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <Modal title={`Members — ${project.name}`} icon={<Users size={15} className="text-ae7-red" />} onClose={onClose} wide>
      <div className="p-6 space-y-4">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} className="input pl-9 text-sm" placeholder="Search employees…" autoFocus />
        </div>
        <p className="text-xs text-gray-400">
          {memberIds.size} assigned · check/uncheck to add or remove
        </p>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden max-h-72 overflow-y-auto divide-y divide-gray-50 dark:divide-gray-800">
          {filtered.map(p => (
            <label key={p.id} onClick={() => toggle(p.id)} className={clsx('flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors', memberIds.has(p.id) ? 'bg-ae7-light/50 dark:bg-ae7-red/5' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50')}>
              <div className={clsx('w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors', memberIds.has(p.id) ? 'bg-ae7-red border-ae7-red' : 'border-gray-300 dark:border-gray-600')}>
                {memberIds.has(p.id) && <Check size={10} className="text-white" strokeWidth={3} />}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{p.full_name || '(No name)'}</p>
                <p className="text-xs text-gray-400 truncate">{p.email}</p>
              </div>
            </label>
          ))}
          {filtered.length === 0 && <p className="text-sm text-gray-400 text-center py-6">No employees found.</p>}
        </div>
        <ErrorBox msg={error} />
        <div className="flex gap-3">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">
            {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Check size={15} /> Save members</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Import Modal ─────────────────────────────────────────────────
function ImportModal({ existingProjects, onClose, onImported }) {
  const { profile } = useAuth()
  const [names, setNames]       = useState([])
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('timesheet_entries').select('project_name').not('project_name', 'is', null)
      if (!data) { setLoading(false); return }
      const existingLower = new Set(existingProjects.map(p => p.name.toLowerCase()))
      const unique = [...new Set(data.map(e => e.project_name.trim()).filter(Boolean))]
        .filter(n => !existingLower.has(n.toLowerCase()))
        .sort()
      setNames(unique)
      setSelected(new Set(unique))
      setLoading(false)
    }
    load()
  }, [])

  async function handleImport() {
    if (selected.size === 0) return
    setSaving(true)
    for (const name of selected) {
      const { data: proj, error: projErr } = await supabase
        .from('projects')
        .insert({ name, created_by: profile.id })
        .select()
        .single()
      if (projErr) continue

      const { data: stage } = await supabase
        .from('project_stages')
        .insert({ project_id: proj.id, name: 'Phase 1', order_index: 0, created_by: profile.id })
        .select()
        .single()
      if (stage) {
        await supabase.from('project_stage_logs').insert({
          stage_id: stage.id, project_id: proj.id, changed_by: profile.id,
          change_type: 'create',
        })
      }
    }
    setSaving(false)
    onImported()
    onClose()
  }

  function toggle(n) {
    setSelected(prev => { const s = new Set(prev); s.has(n) ? s.delete(n) : s.add(n); return s })
  }

  return (
    <Modal title="Import from timesheets" icon={<Download size={15} className="text-ae7-red" />} onClose={onClose}>
      <div className="p-6 space-y-4">
        {loading ? (
          <div className="py-8 text-center text-sm text-gray-400">Scanning timesheet entries…</div>
        ) : names.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">
            No unmanaged projects found in existing timesheets.
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              These project names exist in timesheet entries but aren't managed yet. Each will be created with a <strong>Phase 1</strong> stage (dates undefined).
            </p>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden max-h-60 overflow-y-auto divide-y divide-gray-50 dark:divide-gray-800">
              {names.map(n => (
                <label key={n} className={clsx('flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors text-sm', selected.has(n) ? 'bg-ae7-light/50 dark:bg-ae7-red/5' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50')}>
                  <div className={clsx('w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0', selected.has(n) ? 'bg-ae7-red border-ae7-red' : 'border-gray-300 dark:border-gray-600')}>
                    {selected.has(n) && <Check size={10} className="text-white" strokeWidth={3} />}
                  </div>
                  <span className="truncate">{n}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-400">{selected.size} of {names.length} selected</p>
          </>
        )}
        <ErrorBox msg={error} />
        <div className="flex gap-3">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={handleImport} disabled={saving || loading || selected.size === 0} className="btn-primary flex-1">
            {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Download size={15} /> Import {selected.size > 0 ? `${selected.size} ` : ''}project{selected.size !== 1 ? 's' : ''}</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Stage Row ────────────────────────────────────────────────────
function StageRow({ stage, project, onDateAction, onArchiveStage, readonly }) {
  const state = getStageDateState(stage)
  const startLabel = formatDate(stage.start_date)
  const endLabel   = formatDate(stage.end_date)

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-800/40 flex-wrap">
      <div className="min-w-0">
        <p className="text-sm font-medium">{stage.name}</p>
        <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
          <CalendarDays size={11} />
          {startLabel ? startLabel : <span className="italic">Start not set</span>}
          <span className="mx-0.5">→</span>
          {endLabel ? endLabel : <span className="italic">End not set</span>}
        </p>
      </div>
      {!readonly && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {state === 'none' && (
            <button onClick={() => onDateAction(stage, project, 'define_both')} className="btn-secondary text-xs px-2.5 py-1.5">
              <Calendar size={12} /> Define Dates
            </button>
          )}
          {state === 'start_only' && (
            <button onClick={() => onDateAction(stage, project, 'define_end')} className="btn-secondary text-xs px-2.5 py-1.5">
              <Calendar size={12} /> Define End Date
            </button>
          )}
          {state === 'end_only' && (
            <>
              <button onClick={() => onDateAction(stage, project, 'define_start')} className="btn-secondary text-xs px-2.5 py-1.5">
                <Calendar size={12} /> Define Start
              </button>
              <button onClick={() => onDateAction(stage, project, 'extend_end')} className="btn-secondary text-xs px-2.5 py-1.5 text-amber-600 dark:text-amber-400">
                <CalendarDays size={12} /> Extend End
              </button>
            </>
          )}
          {state === 'both' && (
            <button onClick={() => onDateAction(stage, project, 'extend_end')} className="btn-secondary text-xs px-2.5 py-1.5 text-amber-600 dark:text-amber-400">
              <CalendarDays size={12} /> Extend End Date
            </button>
          )}
          <button
            onClick={() => onArchiveStage(stage, project)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/20 transition-colors"
            title="Archive stage"
          >
            <Archive size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Project Card ─────────────────────────────────────────────────
function ProjectCard({ project, expanded, onToggle, onAddStage, onDateAction, onManageMembers, onArchive, onArchiveStage }) {
  const members        = project.project_members || []
  const allStages      = (project.project_stages || []).sort((a, b) => a.order_index - b.order_index)
  const stages         = allStages.filter(s => !s.is_archived)
  const archivedStages = allStages.filter(s => s.is_archived)
  const isArchived     = project.status === 'archived'

  return (
    <div className={clsx('card overflow-hidden', isArchived && 'opacity-60')}>
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-ae7-red/10 flex items-center justify-center flex-shrink-0">
            <Briefcase size={15} className="text-ae7-red" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">{project.name}</p>
            <p className="text-xs text-gray-400">
              {stages.length} {stages.length === 1 ? 'stage' : 'stages'} · {members.length} {members.length === 1 ? 'member' : 'members'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isArchived && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">Archived</span>
          )}
          {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-800 px-5 py-4 space-y-5">
          {project.description && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{project.description}</p>
          )}

          {/* Stages */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Stages</h3>
              {!isArchived && (
                <button onClick={() => onAddStage(project)} className="text-xs text-ae7-red hover:underline flex items-center gap-1">
                  <Plus size={12} /> Add stage
                </button>
              )}
            </div>
            <div className="space-y-2">
              {stages.length === 0 && archivedStages.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No stages yet.</p>
              ) : stages.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No active stages.</p>
              ) : stages.map(s => (
                <StageRow key={s.id} stage={s} project={project} onDateAction={onDateAction} onArchiveStage={onArchiveStage} readonly={isArchived} />
              ))}
              {archivedStages.length > 0 && (
                <p className="text-xs text-gray-400 italic pt-1">
                  + {archivedStages.length} archived stage{archivedStages.length !== 1 ? 's' : ''} — view in the Archived tab.
                </p>
              )}
            </div>
          </div>

          {/* Members */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Members</h3>
              {!isArchived && (
                <button onClick={() => onManageMembers(project)} className="text-xs text-ae7-red hover:underline flex items-center gap-1">
                  <UserPlus size={12} /> Manage
                </button>
              )}
            </div>
            {members.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No members assigned.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {members.map(m => (
                  <span key={m.id} className="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2.5 py-1 rounded-full">
                    {m.profiles?.full_name || m.profiles?.email || '—'}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Footer actions */}
          {!isArchived && (
            <div className="flex justify-end pt-1 border-t border-gray-100 dark:border-gray-800">
              <button
                onClick={() => onArchive(project)}
                className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 transition-colors"
              >
                <Archive size={12} /> Archive project
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Logs Tab ─────────────────────────────────────────────────────
function LogsTab({ projects }) {
  const [logs, setLogs]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [projectFilter, setFilter] = useState('')
  const [page, setPage]           = useState(1)

  useEffect(() => {
    supabase
      .from('project_stage_logs')
      .select(`
        id, change_type, old_start, new_start, old_end, new_end, reason, created_at,
        project_stages!stage_id (name),
        projects!project_id (id, name),
        profiles!changed_by (full_name, email)
      `)
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (data) setLogs(data); setLoading(false) })
  }, [])

  const filtered = useMemo(() => {
    if (!projectFilter) return logs
    return logs.filter(l => l.projects?.id === projectFilter)
  }, [logs, projectFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  function changeFilter(v) { setFilter(v); setPage(1) }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={projectFilter}
          onChange={e => changeFilter(e.target.value)}
          className="input text-sm max-w-xs"
        >
          <option value="">All projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="text-xs text-gray-400">{filtered.length} log{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {loading ? (
        <div className="card p-12 text-center text-sm text-gray-400">Loading logs…</div>
      ) : paginated.length === 0 ? (
        <div className="card p-12 text-center">
          <ScrollText size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No logs found.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
            <span className="col-span-2">When</span>
            <span className="col-span-2">Project</span>
            <span className="col-span-2">Stage</span>
            <span className="col-span-2">Change</span>
            <span className="col-span-2">Dates</span>
            <span className="col-span-2">By / Reason</span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {paginated.map(log => (
              <div key={log.id} className="sm:grid sm:grid-cols-12 gap-3 px-5 py-3.5 text-sm flex flex-col gap-1">
                <span className="col-span-2 text-xs text-gray-400">
                  {format(new Date(log.created_at), 'dd MMM yyyy HH:mm')}
                </span>
                <span className="col-span-2 font-medium truncate">{log.projects?.name}</span>
                <span className="col-span-2 text-gray-600 dark:text-gray-400 truncate">{log.project_stages?.name}</span>
                <span className="col-span-2">
                  <span className={clsx(
                    'text-xs font-medium px-2 py-0.5 rounded-full',
                    log.change_type === 'create'       ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                    log.change_type === 'extend_end'   ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  )}>
                    {changeTypeLabel[log.change_type] || log.change_type}
                  </span>
                </span>
                <div className="col-span-2 text-xs text-gray-500">
                  {(log.old_start || log.old_end) ? (
                    <span className="line-through text-red-400">{log.old_start ? formatDate(log.old_start) : '—'} → {log.old_end ? formatDate(log.old_end) : '—'}</span>
                  ) : null}
                  {(log.new_start || log.new_end) && (
                    <span className="text-emerald-600 dark:text-emerald-400 block">
                      {log.new_start ? formatDate(log.new_start) : '—'} → {log.new_end ? formatDate(log.new_end) : '—'}
                    </span>
                  )}
                </div>
                <div className="col-span-2 min-w-0">
                  <p className="text-xs text-gray-500 truncate">{log.profiles?.full_name || log.profiles?.email}</p>
                  {log.reason && <p className="text-xs text-gray-400 italic truncate mt-0.5">"{log.reason}"</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────
export default function ProjectsPage() {
  const { profile } = useAuth()
  const [projects, setProjects]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [activeTab, setActiveTab] = useState('projects')
  const [search, setSearch]       = useState('')
  const [expanded, setExpanded]   = useState(null)
  const [toast, setToast]         = useState('')

  // Modals
  const [showCreate, setShowCreate]     = useState(false)
  const [addStageFor, setAddStageFor]   = useState(null)
  const [dateTarget, setDateTarget]     = useState(null)  // { stage, project, action }
  const [membersFor, setMembersFor]     = useState(null)
  const [showImport, setShowImport]     = useState(false)

  const loadProjects = useCallback(async () => {
    const { data } = await supabase
      .from('projects')
      .select(`
        id, name, description, status, created_at,
        project_stages (id, name, start_date, end_date, order_index, is_archived, created_at),
        project_members (
          id, employee_id,
          profiles!employee_id (id, full_name, email)
        )
      `)
      .order('created_at', { ascending: false })
    if (data) setProjects(data)
    setLoading(false)
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 2500) }

  async function handleArchive(project) {
    if (!window.confirm(`Archive "${project.name}"? Timesheets can still be viewed but no new uploads will be accepted.`)) return
    await supabase.from('projects').update({ status: 'archived' }).eq('id', project.id)
    await loadProjects()
    showToast(`"${project.name}" archived.`)
  }

  const shown = useMemo(() => {
    const active = projects.filter(p => p.status !== 'archived')
    if (!search) return active
    const q = search.toLowerCase()
    return active.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q))
  }, [projects, search])

  async function handleArchiveStage(stage, project) {
    if (!window.confirm(`Archive stage "${stage.name}" in "${project.name}"?\n\nExisting timesheet entries linked to this stage are preserved. The stage will no longer appear in active views or upload dropdowns.`)) return
    await supabase.from('project_stages').update({ is_archived: true }).eq('id', stage.id)
    await loadProjects()
    showToast(`Stage "${stage.name}" archived.`)
  }

  const archivedProjects = projects.filter(p => p.status === 'archived')
  const allArchivedStages = projects.flatMap(p =>
    (p.project_stages || []).filter(s => s.is_archived).map(s => ({ ...s, projectName: p.name }))
  )

  const tabs = [
    { id: 'projects', label: 'Projects' },
    { id: 'archived', label: `Archived${archivedProjects.length + allArchivedStages.length > 0 ? ` (${archivedProjects.length + allArchivedStages.length})` : ''}` },
    { id: 'logs',     label: 'Logs' },
  ]

  return (
    <div className="space-y-6 max-w-4xl">
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {showCreate && (
        <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={() => { loadProjects(); showToast('Project created.') }} />
      )}
      {addStageFor && (
        <AddStageModal project={addStageFor} onClose={() => setAddStageFor(null)} onCreated={() => { loadProjects(); showToast('Stage added.') }} />
      )}
      {dateTarget && (
        <DateActionModal
          stage={dateTarget.stage} project={dateTarget.project} action={dateTarget.action}
          onClose={() => setDateTarget(null)}
          onDone={() => { loadProjects(); showToast('Stage updated.') }}
        />
      )}
      {membersFor && (
        <ManageMembersModal project={membersFor} onClose={() => setMembersFor(null)} onSaved={() => { loadProjects(); showToast('Members updated.') }} />
      )}
      {showImport && (
        <ImportModal existingProjects={projects} onClose={() => setShowImport(false)} onImported={() => { loadProjects(); showToast('Projects imported.') }} />
      )}

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Briefcase size={22} className="text-ae7-red" /> Projects Management
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Manage projects, stages, and team assignments.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={clsx(
              'px-4 py-2 rounded-xl text-sm font-medium transition-colors',
              activeTab === t.id ? 'bg-ae7-red text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'projects' && (
        <>
          <div className="flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-0">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)} className="input pl-9" placeholder="Search projects…" />
            </div>
            <button onClick={() => setShowImport(true)} className="btn-secondary flex-shrink-0 text-sm">
              <Download size={15} /> Import existing
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary flex-shrink-0">
              <Plus size={15} /> New project
            </button>
          </div>

          {loading ? (
            <div className="text-center py-16 text-gray-400">Loading…</div>
          ) : shown.length === 0 ? (
            <div className="card p-12 text-center">
              <Briefcase size={40} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
              <p className="text-gray-500 mb-4">{search ? 'No projects match your search.' : 'No projects yet.'}</p>
              {!search && (
                <div className="flex gap-3 justify-center flex-wrap">
                  <button onClick={() => setShowImport(true)} className="btn-secondary text-sm"><Download size={14} /> Import from timesheets</button>
                  <button onClick={() => setShowCreate(true)} className="btn-primary text-sm"><Plus size={14} /> Create project</button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {shown.map(p => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  expanded={expanded === p.id}
                  onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
                  onAddStage={setAddStageFor}
                  onDateAction={(stage, project, action) => setDateTarget({ stage, project, action })}
                  onManageMembers={setMembersFor}
                  onArchive={handleArchive}
                  onArchiveStage={handleArchiveStage}
                />
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'archived' && (
        <div className="space-y-6">
          {/* Archived projects */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Archived projects ({archivedProjects.length})
            </h3>
            {archivedProjects.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No archived projects.</p>
            ) : (
              <div className="space-y-3">
                {archivedProjects.map(p => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    expanded={expanded === p.id}
                    onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
                    onAddStage={() => {}}
                    onDateAction={() => {}}
                    onManageMembers={() => {}}
                    onArchive={() => {}}
                    onArchiveStage={() => {}}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Archived stages */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Archived stages ({allArchivedStages.length})
            </h3>
            {allArchivedStages.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No archived stages.</p>
            ) : (
              <div className="card overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
                {allArchivedStages.map(s => (
                  <div key={s.id} className="flex items-center justify-between px-5 py-3.5 gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{s.name}</p>
                      <p className="text-xs text-gray-400">{s.projectName}</p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 text-xs text-gray-400">
                      <span>{s.start_date ? formatDate(s.start_date) : '—'} → {s.end_date ? formatDate(s.end_date) : '—'}</span>
                      <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">Archived</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'logs' && <LogsTab projects={projects} />}
    </div>
  )
}
