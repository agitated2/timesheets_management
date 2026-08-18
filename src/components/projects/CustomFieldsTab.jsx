// Custom field library — the workspace-level definitions behind
// per-project/per-phase custom dropdowns on timesheet entries.
// See HANDOFF_PLAN.md Task F and migration_v21.
//
// Definitions live here rather than per-project on purpose: per-project
// field names would fragment into "Building"/"building"/"Bldg No." and
// destroy the cross-project aggregation the feature exists for.
//
// Gated to projects_control/it by the cf_manage RLS policies — this tab
// is only rendered for those roles, but the database is the guarantee.

import { useCallback, useEffect, useState } from 'react'
import {
  Plus, Trash2, Pencil, X, Upload, Download, AlertTriangle,
  ChevronDown, ChevronUp, Archive, Check, ListTree,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { parseCSV, toCSV, downloadCSV } from '../../lib/csv'

function Spinner() {
  return <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
}

function ErrorBox({ msg }) {
  if (!msg) return null
  return (
    <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
      <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
      {msg}
    </div>
  )
}

function Shell({ title, icon, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className={clsx('bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full flex flex-col max-h-[90vh]', wide ? 'max-w-2xl' : 'max-w-md')}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">{icon}<h3 className="font-semibold text-sm">{title}</h3></div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

// ── Create / rename a field ────────────────────────────────────────
function FieldModal({ field, onClose, onSaved }) {
  const [name, setName] = useState(field?.name || '')
  const [description, setDescription] = useState(field?.description || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required.'); return }
    setSaving(true)
    setError('')
    const payload = { name: name.trim(), description: description.trim() || null }
    const { error: err } = field
      ? await supabase.from('custom_fields').update(payload).eq('id', field.id)
      : await supabase.from('custom_fields').insert(payload)
    setSaving(false)
    if (err) {
      // The case-insensitive unique index is what actually prevents
      // "Building" and "building" coexisting; translate its raw message.
      setError(err.code === '23505' ? 'A field with that name already exists.' : err.message)
      return
    }
    onSaved()
    onClose()
  }

  return (
    <Shell
      title={field ? `Edit: ${field.name}` : 'New custom field'}
      icon={<ListTree size={16} className="text-ae7-red" />}
      onClose={onClose}
    >
      <form onSubmit={save} className="p-6 space-y-4">
        <div>
          <label className="label">Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} className="input" placeholder="Building" required autoFocus />
        </div>
        <div>
          <label className="label">Description</label>
          <input value={description} onChange={e => setDescription(e.target.value)} className="input" placeholder="Which building the work relates to" />
        </div>
        {!field && (
          <p className="text-xs text-gray-400">
            An "N/A" option is added automatically and is the default selection on every timesheet entry.
          </p>
        )}
        <ErrorBox msg={error} />
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary flex-1">
            {saving ? <Spinner /> : <><Check size={15} /> {field ? 'Save' : 'Create'}</>}
          </button>
        </div>
      </form>
    </Shell>
  )
}

// ── Bulk option import (CSV) ───────────────────────────────────────
// CSV, not XLSX, deliberately: `xlsx` carries an unfixed high-severity
// advisory and this is another untrusted-input path. src/lib/csv.js has
// no dependencies at all.
function ImportOptionsModal({ field, existingLabels, onClose, onImported }) {
  const [rows, setRows] = useState(null)     // { label }[] parsed from file
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function handleFile(file) {
    if (!file) return
    setError('')
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseCSV(String(reader.result))
        if (parsed.length === 0) { setError('That file has no data rows.'); return }
        const key = Object.keys(parsed[0]).find(k => k.toLowerCase() === 'label')
        if (!key) { setError('The file needs a "label" column. Download the template for the expected format.'); return }
        setRows(parsed.map(r => (r[key] || '').trim()).filter(Boolean).map(label => ({ label })))
      } catch {
        setError('Could not parse that file as CSV.')
      }
    }
    reader.onerror = () => setError('Could not read that file.')
    reader.readAsText(file)
  }

  // Case-insensitive de-dup against both what's already stored and
  // repeats within the file, so re-importing the same list is a no-op
  // rather than doubling every option.
  const existingLower = new Set(existingLabels.map(l => l.toLowerCase()))
  const seen = new Set()
  const classified = (rows || []).map(r => {
    const lower = r.label.toLowerCase()
    let status = 'new'
    if (existingLower.has(lower)) status = 'exists'
    else if (seen.has(lower)) status = 'duplicate'
    else seen.add(lower)
    return { ...r, status }
  })
  const toAdd = classified.filter(r => r.status === 'new')

  async function commit() {
    setSaving(true)
    setError('')
    // sort_order continues after whatever's already there; the N/A
    // sentinel sits at -1 so it always stays first.
    const { data: maxRow } = await supabase
      .from('custom_field_options')
      .select('sort_order').eq('field_id', field.id)
      .order('sort_order', { ascending: false }).limit(1).maybeSingle()
    const base = (maxRow?.sort_order ?? 0) + 1
    const { error: err } = await supabase.from('custom_field_options').insert(
      toAdd.map((r, i) => ({ field_id: field.id, label: r.label, sort_order: base + i }))
    )
    setSaving(false)
    if (err) { setError(err.message); return }
    onImported()
    onClose()
  }

  return (
    <Shell title={`Import options: ${field.name}`} icon={<Upload size={16} className="text-ae7-red" />} onClose={onClose} wide>
      <div className="p-6 space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Upload a CSV with a <code>label</code> column — one option per row.
          Options already in the list are skipped, so re-importing is safe.
        </p>

        <button onClick={() => downloadCSV('custom-field-options-template.csv', toCSV([{ label: 'Building A' }, { label: 'Building B' }], ['label']))} className="btn-secondary text-sm">
          <Download size={14} /> Download template
        </button>

        <div>
          <label className="label">CSV file</label>
          <input type="file" accept=".csv,text/csv" onChange={e => handleFile(e.target.files?.[0])} className="input text-sm" />
          {fileName && rows && <p className="text-xs text-gray-400 mt-1.5">{fileName} — {rows.length} row{rows.length !== 1 ? 's' : ''} parsed.</p>}
        </div>

        <ErrorBox msg={error} />

        {classified.length > 0 && (
          <>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">{toAdd.length} to add</span>
              {classified.length - toAdd.length > 0 && (
                <span className="text-gray-400">{classified.length - toAdd.length} already present or repeated</span>
              )}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
              {classified.map((r, i) => (
                <div key={i} className="px-3 py-2 flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{r.label}</span>
                  <span className={clsx(
                    'text-xs flex-shrink-0',
                    r.status === 'new' ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'
                  )}>
                    {r.status === 'new' ? 'Add' : r.status === 'exists' ? 'Already exists' : 'Repeated in file'}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex gap-3 px-6 py-4 border-t border-gray-100 dark:border-gray-800">
        <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
        <button onClick={commit} disabled={saving || toAdd.length === 0} className="btn-primary flex-1">
          {saving ? <Spinner /> : `Add ${toAdd.length} option${toAdd.length !== 1 ? 's' : ''}`}
        </button>
      </div>
    </Shell>
  )
}

// ── One field's option list ────────────────────────────────────────
function OptionList({ field, options, onChanged, showToast }) {
  const [newLabel, setNewLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const visible = options.filter(o => showArchived || !o.is_archived)

  async function addOption(e) {
    e.preventDefault()
    if (!newLabel.trim()) return
    setAdding(true)
    setError('')
    const maxOrder = options.reduce((m, o) => Math.max(m, o.sort_order), 0)
    const { error: err } = await supabase.from('custom_field_options')
      .insert({ field_id: field.id, label: newLabel.trim(), sort_order: maxOrder + 1 })
    setAdding(false)
    if (err) {
      setError(err.code === '23505' ? 'That option already exists.' : err.message)
      return
    }
    setNewLabel('')
    onChanged()
  }

  // D-c: warn with a usage count, then allow. Archiving never deletes —
  // existing timesheet values keep resolving through the FK.
  async function archiveOption(opt) {
    const { data: usage } = await supabase.rpc('custom_field_option_usage', { p_option: opt.id })
    const count = usage ?? 0
    const msg = count > 0
      ? `"${opt.label}" is used by ${count} timesheet ${count === 1 ? 'entry' : 'entries'}. Archiving hides it from new entries; existing ones keep it. Continue?`
      : `Archive "${opt.label}"? It will no longer be selectable on new entries.`
    if (!window.confirm(msg)) return
    const { error: err } = await supabase.from('custom_field_options').update({ is_archived: true }).eq('id', opt.id)
    if (err) { showToast('Error: ' + err.message); return }
    onChanged()
  }

  async function unarchiveOption(opt) {
    const { error: err } = await supabase.from('custom_field_options').update({ is_archived: false }).eq('id', opt.id)
    if (err) { showToast('Error: ' + err.message); return }
    onChanged()
  }

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Options <span className="font-normal normal-case tracking-normal text-gray-300 dark:text-gray-600">{visible.length}</span>
        </p>
        {options.some(o => o.is_archived) && (
          <button onClick={() => setShowArchived(v => !v)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            {showArchived ? 'Hide archived' : `Show archived (${options.filter(o => o.is_archived).length})`}
          </button>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800 max-h-56 overflow-y-auto">
        {visible.map(o => (
          <div key={o.id} className={clsx('px-3 py-2 flex items-center justify-between gap-3 text-sm', o.is_archived && 'opacity-50')}>
            <span className="truncate flex items-center gap-2">
              {o.label}
              {o.is_na_sentinel && (
                <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1">default</span>
              )}
            </span>
            {/* The N/A sentinel is protected in the DB too — this just
                avoids offering an action that would always fail. */}
            {!o.is_na_sentinel && (
              o.is_archived ? (
                <button onClick={() => unarchiveOption(o)} className="text-xs text-gray-400 hover:text-gray-600 flex-shrink-0">Restore</button>
              ) : (
                <button onClick={() => archiveOption(o)} className="text-gray-400 hover:text-amber-600 flex-shrink-0" title="Archive">
                  <Archive size={14} />
                </button>
              )
            )}
          </div>
        ))}
        {visible.length === 0 && <p className="px-3 py-3 text-xs text-gray-400">No options yet.</p>}
      </div>

      <form onSubmit={addOption} className="flex gap-2">
        <input value={newLabel} onChange={e => setNewLabel(e.target.value)} className="input text-sm flex-1" placeholder="Add an option…" />
        <button type="submit" disabled={adding || !newLabel.trim()} className="btn-secondary text-sm flex-shrink-0">
          {adding ? '…' : <><Plus size={14} /> Add</>}
        </button>
      </form>

      <ErrorBox msg={error} />
    </div>
  )
}

// ── Main tab ───────────────────────────────────────────────────────
export default function CustomFieldsTab({ showToast }) {
  const [fields, setFields] = useState([])
  const [options, setOptions] = useState({})   // field_id -> option[]
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [editing, setEditing] = useState(undefined)  // undefined = closed, null = new
  const [importFor, setImportFor] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: f, error: fErr }, { data: o, error: oErr }] = await Promise.all([
      supabase.from('custom_fields').select('*').order('name'),
      supabase.from('custom_field_options').select('*').order('sort_order'),
    ])
    setLoading(false)
    if (fErr || oErr) { setError((fErr || oErr).message); return }
    setError('')
    setFields(f || [])
    const byField = {}
    ;(o || []).forEach(opt => { (byField[opt.field_id] ||= []).push(opt) })
    setOptions(byField)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleActive(field) {
    const { error: err } = await supabase.from('custom_fields')
      .update({ is_active: !field.is_active }).eq('id', field.id)
    if (err) { showToast('Error: ' + err.message); return }
    showToast(field.is_active ? 'Field disabled.' : 'Field enabled.')
    load()
  }

  async function deleteField(field) {
    const optCount = (options[field.id] || []).filter(o => !o.is_na_sentinel).length
    if (!window.confirm(
      `Delete "${field.name}" and its ${optCount} option${optCount !== 1 ? 's' : ''}?\n\n` +
      `This is blocked if any timesheet entry has used it — disable the field instead to stop it appearing on new entries while keeping past data.`
    )) return
    const { error: err } = await supabase.from('custom_fields').delete().eq('id', field.id)
    if (err) {
      // The values table FKs option_id with ON DELETE RESTRICT, so a
      // field that's been used cannot be deleted. Say so plainly rather
      // than showing a raw constraint error.
      showToast(err.code === '23503'
        ? 'That field has been used on timesheets and cannot be deleted. Disable it instead.'
        : 'Error: ' + err.message)
      return
    }
    showToast('Field deleted.')
    load()
  }

  return (
    <div className="space-y-4">
      {editing !== undefined && (
        <FieldModal field={editing} onClose={() => setEditing(undefined)} onSaved={() => { load(); showToast(editing ? 'Field updated.' : 'Field created.') }} />
      )}
      {importFor && (
        <ImportOptionsModal
          field={importFor}
          existingLabels={(options[importFor.id] || []).map(o => o.label)}
          onClose={() => setImportFor(null)}
          onImported={() => { load(); showToast('Options imported.') }}
        />
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xl">
          Dropdowns you can attach to a project or an individual phase. Once attached,
          employees pick a value when logging time against that phase, and you can filter
          and group Project Analytics by it.
        </p>
        <button onClick={() => setEditing(null)} className="btn-primary flex-shrink-0">
          <Plus size={15} /> New field
        </button>
      </div>

      <ErrorBox msg={error} />

      {loading ? (
        <div className="card p-6"><div className="h-20 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" /></div>
      ) : fields.length === 0 ? (
        <div className="card p-12 text-center">
          <ListTree size={36} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No custom fields yet.</p>
          <p className="text-xs text-gray-400 mt-1">Create one to start tracking extra detail on timesheet entries.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map(f => {
            const opts = options[f.id] || []
            const isOpen = expanded === f.id
            const realCount = opts.filter(o => !o.is_na_sentinel && !o.is_archived).length
            return (
              <div key={f.id} className="card overflow-hidden">
                <div className="flex items-center gap-3 px-5 py-3">
                  <button onClick={() => setExpanded(isOpen ? null : f.id)} className="flex-1 flex items-center gap-2 min-w-0 text-left">
                    {isOpen ? <ChevronUp size={15} className="text-gray-400 flex-shrink-0" /> : <ChevronDown size={15} className="text-gray-400 flex-shrink-0" />}
                    <span className={clsx('font-medium text-sm truncate', !f.is_active && 'text-gray-400')}>{f.name}</span>
                    <span className="text-xs text-gray-400 flex-shrink-0">{realCount} option{realCount !== 1 ? 's' : ''}</span>
                    {!f.is_active && (
                      <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded px-1 flex-shrink-0">disabled</span>
                    )}
                  </button>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => setImportFor(f)} className="p-1.5 rounded-lg text-gray-400 hover:text-ae7-red hover:bg-gray-50 dark:hover:bg-gray-800" title="Import options from CSV">
                      <Upload size={14} />
                    </button>
                    <button onClick={() => setEditing(f)} className="p-1.5 rounded-lg text-gray-400 hover:text-ae7-red hover:bg-gray-50 dark:hover:bg-gray-800" title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => toggleActive(f)} className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-gray-50 dark:hover:bg-gray-800" title={f.is_active ? 'Disable' : 'Enable'}>
                      <Archive size={14} />
                    </button>
                    <button onClick={() => deleteField(f)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20" title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="px-5 pb-4 border-t border-gray-100 dark:border-gray-800">
                    {f.description && <p className="text-xs text-gray-400 pt-3">{f.description}</p>}
                    <OptionList field={f} options={opts} onChanged={load} showToast={showToast} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
