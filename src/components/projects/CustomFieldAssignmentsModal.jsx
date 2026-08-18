// Assign custom fields to a project, with optional per-phase overrides.
// See migration_v21 (b)/(c) and HANDOFF_PLAN.md decision D-d.
//
// The model, restated because it drives the whole UI:
//   * A project-level assignment (stage_id NULL) applies to EVERY phase.
//   * A phase-level assignment overrides the project-level one for that
//     phase only.
//   * 'disabled' is a real stored requirement, not the absence of a row —
//     that's how a single phase opts out of an otherwise project-wide
//     field. "Not assigned" and "explicitly off" are different states and
//     the UI has to let you express both.

import { useCallback, useEffect, useState } from 'react'
import { X, AlertTriangle, ListTree, ChevronDown, ChevronUp } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'

const REQUIREMENTS = [
  { value: 'optional', label: 'Optional' },
  { value: 'required', label: 'Required' },
  { value: 'disabled', label: 'Off' },
]

// Tri-state + "not assigned". Kept as a plain segmented control rather
// than a <select> so the current state is readable without interaction —
// this screen is mostly about scanning what's already set.
function RequirementPicker({ value, onChange, inheritedLabel, disabled }) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={disabled}
        className={clsx(
          'text-xs px-2 py-1 rounded-md border transition-colors disabled:opacity-40',
          value === null
            ? 'border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-medium'
            : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
        )}
        title={inheritedLabel ? `Inherit: ${inheritedLabel}` : 'Not assigned'}
      >
        {inheritedLabel ? `Inherit (${inheritedLabel})` : 'Not set'}
      </button>
      {REQUIREMENTS.map(r => (
        <button
          key={r.value}
          type="button"
          onClick={() => onChange(r.value)}
          disabled={disabled}
          className={clsx(
            'text-xs px-2 py-1 rounded-md border transition-colors disabled:opacity-40',
            value === r.value
              ? r.value === 'disabled'
                ? 'border-transparent bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-medium'
                : 'border-transparent bg-ae7-red text-white font-medium'
              : 'border-gray-200 dark:border-gray-700 text-gray-500 hover:border-gray-300'
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

export default function CustomFieldAssignmentsModal({ project, onClose, onSaved }) {
  const [fields, setFields] = useState([])
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyKey, setBusyKey] = useState(null)
  const [expandedField, setExpandedField] = useState(null)

  const stages = (project.project_stages || [])
    .filter(s => !s.is_archived)
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: f, error: fErr }, { data: a, error: aErr }] = await Promise.all([
      supabase.from('custom_fields').select('id, name, is_active').eq('is_active', true).order('name'),
      supabase.from('custom_field_assignments').select('*').eq('project_id', project.id),
    ])
    setLoading(false)
    if (fErr || aErr) { setError((fErr || aErr).message); return }
    setError('')
    setFields(f || [])
    setAssignments(a || [])
  }, [project.id])

  useEffect(() => { load() }, [load])

  function findAssignment(fieldId, stageId) {
    return assignments.find(a => a.field_id === fieldId && (stageId ? a.stage_id === stageId : a.stage_id === null))
  }

  // requirement === null means "remove the row" — i.e. fall back to the
  // project-level assignment, or to not-assigned if there isn't one.
  async function setRequirement(fieldId, stageId, requirement) {
    const key = `${fieldId}:${stageId || 'project'}`
    setBusyKey(key)
    setError('')
    const existing = findAssignment(fieldId, stageId)

    let err
    if (requirement === null) {
      if (existing) ({ error: err } = await supabase.from('custom_field_assignments').delete().eq('id', existing.id))
    } else if (existing) {
      ({ error: err } = await supabase.from('custom_field_assignments').update({ requirement }).eq('id', existing.id))
    } else {
      ({ error: err } = await supabase.from('custom_field_assignments').insert({
        field_id: fieldId, project_id: project.id, stage_id: stageId || null, requirement,
      }))
    }

    setBusyKey(null)
    if (err) { setError(err.message); return }
    await load()
    onSaved?.()
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full max-w-2xl flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <ListTree size={16} className="text-ae7-red" />
            <h3 className="font-semibold text-sm">Custom fields: {project.name}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
              <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          <p className="text-sm text-gray-500 dark:text-gray-400">
            Set a field at project level to apply it to every phase. Expand a field to
            override individual phases — including turning it off for just one.
          </p>

          {loading ? (
            <div className="h-24 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
          ) : fields.length === 0 ? (
            <div className="text-center py-10">
              <ListTree size={32} className="text-gray-300 dark:text-gray-700 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No active custom fields.</p>
              <p className="text-xs text-gray-400 mt-1">Create one on the Custom Fields tab first.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {fields.map(f => {
                const projectLevel = findAssignment(f.id, null)
                const isOpen = expandedField === f.id
                const overrideCount = assignments.filter(a => a.field_id === f.id && a.stage_id).length
                return (
                  <div key={f.id} className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{f.name}</span>
                        {overrideCount > 0 && (
                          <span className="text-xs text-gray-400 flex-shrink-0">{overrideCount} phase override{overrideCount !== 1 ? 's' : ''}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <RequirementPicker
                          value={projectLevel?.requirement ?? null}
                          onChange={r => setRequirement(f.id, null, r)}
                          disabled={busyKey === `${f.id}:project`}
                        />
                        {stages.length > 0 && (
                          <button
                            onClick={() => setExpandedField(isOpen ? null : f.id)}
                            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            title="Per-phase overrides"
                          >
                            {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </button>
                        )}
                      </div>
                    </div>

                    {isOpen && (
                      <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/20 divide-y divide-gray-100 dark:divide-gray-800">
                        {stages.map(s => {
                          const stageLevel = findAssignment(f.id, s.id)
                          return (
                            <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-2 flex-wrap">
                              <span className="text-sm text-gray-600 dark:text-gray-300 min-w-0 truncate">{s.name}</span>
                              <RequirementPicker
                                value={stageLevel?.requirement ?? null}
                                onChange={r => setRequirement(f.id, s.id, r)}
                                inheritedLabel={
                                  projectLevel
                                    ? REQUIREMENTS.find(r => r.value === projectLevel.requirement)?.label
                                    : null
                                }
                                disabled={busyKey === `${f.id}:${s.id}`}
                              />
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
          <button onClick={onClose} className="btn-primary w-full">Done</button>
        </div>
      </div>
    </div>
  )
}
