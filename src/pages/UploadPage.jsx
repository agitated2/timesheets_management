import { useCallback, useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  Upload, FileSpreadsheet, CheckCircle, AlertCircle, X, UserX,
  Calendar, Clock, ChevronDown, ChevronUp, AlertTriangle, XCircle,
  PlusCircle, Plus, Trash2, Briefcase, ChevronRight,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function calcHours(from, to) {
  if (!from || !to) return null
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  let h = (th + tm / 60) - (fh + fm / 60)
  if (h < 0) h += 24
  return Math.round(h * 100) / 100
}

// ── Manager gate ─────────────────────────────────────────────────
function ManagerGate() {
  return (
    <div className="max-w-lg mx-auto">
      <div className="card p-10 text-center space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center mx-auto">
          <UserX size={28} className="text-amber-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-1">Line manager required</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You need a line manager assigned before you can upload timesheets.
            Contact your IT department to have one assigned.
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Success screen ───────────────────────────────────────────────
function SuccessScreen({ result, onReset, navigate }) {
  const { days, totalDays, totalHours } = result
  const [expandedDay, setExpandedDay] = useState(null)
  const isMulti = totalDays > 1

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="card p-8 text-center">
        <CheckCircle size={48} className="text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-bold mb-1">
          {isMulti ? `${totalDays} timesheets submitted!` : 'Timesheet submitted!'}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Your manager has been notified and will review {isMulti ? 'them' : 'it'} shortly.
        </p>

        <div className="flex items-center justify-center gap-6 bg-gray-50 dark:bg-gray-800 rounded-xl p-4 mb-5">
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalDays}</p>
            <p className="text-xs text-gray-400">{totalDays === 1 ? 'day' : 'days'}</p>
          </div>
          <div className="w-px h-10 bg-gray-200 dark:bg-gray-700" />
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalHours}</p>
            <p className="text-xs text-gray-400">total hours</p>
          </div>
        </div>

        <div className="space-y-2 text-left mb-6">
          {days.map((day, di) => {
            const isOpen = expandedDay === di
            const dateLabel = format(parseISO(day.date), isMulti ? 'EEE, MMM d, yyyy' : 'MMMM d, yyyy')
            return (
              <div key={day.date} className="bg-gray-50 dark:bg-gray-800 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedDay(isOpen ? null : di)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-blue-500 flex-shrink-0" />
                    <span className="text-sm font-medium">{dateLabel}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">{day.hours}h · {day.entries?.length ?? day.entriesCount ?? 0} entries</span>
                    {isOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                  </div>
                </button>
                {isOpen && day.entries?.length > 0 && (
                  <div className="border-t border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700/50">
                    {day.entries.map((e, i) => (
                      <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div className="min-w-0">
                          <span className="font-medium">{e.project_name || '—'}</span>
                          {e.task && <span className="text-gray-400 ml-2 text-xs">· {e.task}</span>}
                        </div>
                        <span className="text-gray-400 text-xs flex-shrink-0 ml-3">
                          {e.time_from} – {e.time_to} ({e.hours_decimal}h)
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex gap-3">
          <button onClick={onReset} className="btn-secondary flex-1">Upload another</button>
          <button onClick={() => navigate('/history')} className="btn-primary flex-1">View history</button>
        </div>
      </div>
    </div>
  )
}

// ── Confirmation screen ──────────────────────────────────────────
function ConfirmationScreen({ preview, onConfirm, onCancel, confirming }) {
  const {
    days, totalDays, totalHours,
    discrepancies = [], hasDiscrepancies = false,
    projectViolations = [], hasProjectViolations = false,
  } = preview
  const blocked = hasDiscrepancies || hasProjectViolations
  const [expandedDay, setExpandedDay] = useState(null)
  const isMulti   = totalDays > 1
  const dateRange = isMulti
    ? `${format(parseISO(days[0].date), 'MMM d')} – ${format(parseISO(days[days.length - 1].date), 'MMM d, yyyy')}`
    : format(parseISO(days[0].date), 'MMMM d, yyyy')

  function violationMessage(v) {
    switch (v.type) {
      case 'project_not_found':
        return { title: `Project "${v.project}" not found`, body: 'This project is not registered in the system. Contact your line manager to have it created.' }
      case 'not_member':
        return { title: `Not assigned to "${v.project}"`, body: 'You are not a member of this project. Contact your line manager to be added.' }
      case 'stage_not_found':
        return { title: `Stage "${v.stage}" not found in "${v.project}"`, body: 'This stage does not exist for the project. Contact your line manager.' }
      case 'stage_expired':
        return { title: `Stage "${v.stage}" is not active`, body: `The running time for this stage has elapsed. Contact your line manager to extend it.` }
      default:
        return { title: 'Project issue', body: 'Contact your line manager.' }
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-5">
      <div className="card p-6 space-y-5">
        <div className="text-center">
          <div className={clsx('w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3', blocked ? 'bg-red-50 dark:bg-red-950/30' : 'bg-gray-50 dark:bg-gray-800')}>
            {blocked ? <XCircle size={22} className="text-red-500" /> : <Calendar size={22} className="text-ae7-red" />}
          </div>
          <h2 className="text-lg font-semibold">{blocked ? 'Issues found' : 'Confirm submission'}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {blocked
              ? 'Your timesheet cannot be submitted until the issues below are resolved.'
              : <>You are uploading {isMulti ? <strong>timesheets for {totalDays} days</strong> : <strong>a timesheet for 1 day</strong>}.</>
            }
          </p>
          {!blocked && isMulti && <p className="text-xs text-gray-400 mt-0.5">{dateRange}</p>}
        </div>

        {/* ── Discrepancy list ──────────────────────────────── */}
        {hasDiscrepancies && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {discrepancies.length} time discrepanc{discrepancies.length !== 1 ? 'ies' : 'y'}
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {discrepancies.map((d, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-800 dark:text-gray-200 truncate">
                        {d.project} · {format(parseISO(d.date), 'EEE MMM d')}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        Time range <strong>{d.timeRange}</strong> = <strong>{d.calculatedHours}h</strong>
                        {' '}but Total Hours column shows <strong>{d.statedHours}h</strong>
                      </p>
                    </div>
                    <span className="text-xs font-mono bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-md flex-shrink-0 whitespace-nowrap">
                      Row {d.rowNumber}
                    </span>
                  </div>
                  {Math.abs(d.calculatedHours - d.statedHours) >= 10 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 flex items-center gap-1">
                      <AlertTriangle size={11} className="flex-shrink-0" />
                      Large gap — possible AM/PM confusion?
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Fix these in your Excel file and re-upload. Row numbers match the Excel display.
            </p>
          </div>
        )}

        {/* ── Project violations ───────────────────────────── */}
        {hasProjectViolations && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {projectViolations.length} project issue{projectViolations.length !== 1 ? 's' : ''}
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {projectViolations.map((v, i) => {
                const { title, body } = violationMessage(v)
                return (
                  <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-800 dark:text-gray-200">{title}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{body}</p>
                      </div>
                      {v.rowNumbers?.length > 0 && (
                        <span className="text-xs font-mono bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-md flex-shrink-0 whitespace-nowrap">
                          Row{v.rowNumbers.length > 1 ? 's' : ''} {v.rowNumbers.join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Resolve the project/stage issues in your Excel file and re-upload. Contact your line manager if needed.
            </p>
          </div>
        )}

        {/* ── Expandable day breakdown (only when no issues) ── */}
        {!blocked && (
          <>
            <div className="space-y-2">
              {days.map((day, di) => {
                const isOpen = expandedDay === di
                const dateLabel = format(parseISO(day.date), isMulti ? 'EEE, MMM d, yyyy' : 'MMMM d, yyyy')
                return (
                  <div key={day.date} className="bg-gray-50 dark:bg-gray-800 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedDay(isOpen ? null : di)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="text-ae7-red flex-shrink-0" />
                        <span className="text-sm font-medium">{dateLabel}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-400">{day.hours}h · {day.entriesCount} {day.entriesCount === 1 ? 'entry' : 'entries'}</span>
                        {isOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                      </div>
                    </button>
                    {isOpen && day.entries?.length > 0 && (
                      <div className="border-t border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700/50">
                        {day.entries.map((e, i) => (
                          <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                            <div className="min-w-0">
                              <span className="font-medium">{e.project_name || '—'}</span>
                              {e.task && <span className="text-gray-400 ml-2 text-xs">· {e.task}</span>}
                            </div>
                            <span className="text-gray-400 text-xs flex-shrink-0 ml-3">
                              {e.time_from} – {e.time_to} ({e.hours_decimal}h)
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-xs text-gray-400 text-center">
              {isMulti
                ? 'This will create one timesheet submission per day. Each is reviewed independently.'
                : 'Your manager will be notified to review this timesheet.'}
            </p>
          </>
        )}

        <div className="flex gap-3">
          <button onClick={onCancel} disabled={confirming} className="btn-secondary flex-1">
            {blocked ? 'Back' : 'Cancel'}
          </button>
          {blocked ? (
            <div className="flex-1 flex items-center justify-center px-4 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-800 text-xs text-gray-400 font-medium text-center">
              Resolve issues to continue
            </div>
          ) : (
            <button onClick={onConfirm} disabled={confirming} className="btn-primary flex-1">
              {confirming
                ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Submitting…</>
                : <><CheckCircle size={15} /> Confirm &amp; Submit</>
              }
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── In-App Entry ─────────────────────────────────────────────────
function InAppEntry({ profile, onBack, onSuccess }) {
  const [projects, setProjects]       = useState([])
  const [loadingProjects, setLoading] = useState(true)
  const [dateEntries, setDateEntries] = useState([newDateEntry()])
  const [submitting, setSubmitting]   = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    async function load() {
      const { data: members } = await supabase
        .from('project_members')
        .select('project_id')
        .eq('employee_id', profile.id)
      const ids = (members || []).map(m => m.project_id)
      if (ids.length === 0) { setLoading(false); return }
      const { data: projs } = await supabase
        .from('projects')
        .select('id, name, project_stages(id, name, start_date, end_date, order_index)')
        .in('id', ids)
        .eq('status', 'active')
        .order('name')
      setProjects(projs || [])
      setLoading(false)
    }
    load()
  }, [profile.id])

  function newDateEntry() {
    return { id: crypto.randomUUID(), date: format(new Date(), 'yyyy-MM-dd'), entries: [] }
  }
  function newEntry() {
    return { id: crypto.randomUUID(), projectId: '', stageId: '', timeFrom: '', timeTo: '', task: '' }
  }

  function addDate() { setDateEntries(prev => [...prev, newDateEntry()]) }
  function removeDate(id) { setDateEntries(prev => prev.filter(d => d.id !== id)) }
  function setDate(id, date) { setDateEntries(prev => prev.map(d => d.id === id ? { ...d, date } : d)) }
  function addEntry(dateId) {
    setDateEntries(prev => prev.map(d => d.id === dateId ? { ...d, entries: [...d.entries, newEntry()] } : d))
  }
  function removeEntry(dateId, entryId) {
    setDateEntries(prev => prev.map(d => d.id === dateId ? { ...d, entries: d.entries.filter(e => e.id !== entryId) } : d))
  }
  function updateEntry(dateId, entryId, field, value) {
    setDateEntries(prev => prev.map(d =>
      d.id === dateId
        ? { ...d, entries: d.entries.map(e => e.id === entryId ? { ...e, [field]: value, ...(field === 'projectId' ? { stageId: '' } : {}) } : e) }
        : d
    ))
  }

  function getStageWarning(entry, date) {
    if (!entry.projectId || !entry.stageId || !date) return null
    const proj  = projects.find(p => p.id === entry.projectId)
    const stage = proj?.project_stages?.find(s => s.id === entry.stageId)
    if (!stage) return null
    const { start_date: s, end_date: e } = stage
    if (!s && !e) return null
    if (e && date > e)
      return `Stage "${stage.name}" ended on ${e}. Contact your line manager.`
    if (s && date < s)
      return `Stage "${stage.name}" hasn't started yet (starts ${s}).`
    return null
  }

  // Collect all stage warnings across all entries
  const stageIssues = dateEntries.flatMap(de =>
    de.entries
      .map(e => ({ e, de, warning: getStageWarning(e, de.date) }))
      .filter(({ warning }) => !!warning)
  )

  const hasStageIssues = stageIssues.length > 0

  const isReady = !hasStageIssues &&
    dateEntries.length > 0 &&
    dateEntries.every(de =>
      de.date && de.entries.length > 0 &&
      de.entries.every(e => e.projectId && e.stageId && e.timeFrom && e.timeTo)
    )

  async function handleSubmit() {
    setSubmitError('')
    setSubmitting(true)
    const resultDays = []
    for (const de of dateEntries) {
      if (!de.date || de.entries.length === 0) continue
      const totalHours = de.entries.reduce((s, e) => s + (calcHours(e.timeFrom, e.timeTo) || 0), 0)

      const { data: ts, error: tsErr } = await supabase
        .from('timesheets')
        .insert({
          employee_id: profile.id,
          date:        de.date,
          file_path:   'inapp',
          total_hours: Math.round(totalHours * 100) / 100,
        })
        .select()
        .single()

      if (tsErr) { setSubmitError(tsErr.message); setSubmitting(false); return }

      const entries = de.entries.map(e => {
        const proj  = projects.find(p => p.id === e.projectId)
        const stage = proj?.project_stages?.find(s => s.id === e.stageId)
        const hrs   = calcHours(e.timeFrom, e.timeTo)
        return {
          timesheet_id:  ts.id,
          time_from:     e.timeFrom  || null,
          time_to:       e.timeTo    || null,
          hours_decimal: hrs,
          project_name:  proj?.name  || null,
          task:          [stage?.name, e.task].filter(Boolean).join(' — ') || null,
        }
      })

      const { error: entErr } = await supabase.from('timesheet_entries').insert(entries)
      if (entErr) { setSubmitError(entErr.message); setSubmitting(false); return }

      resultDays.push({
        date:    de.date,
        hours:   Math.round(totalHours * 100) / 100,
        entries: entries.map(({ timesheet_id, ...e }) => e),
      })
    }

    setSubmitting(false)
    onSuccess({
      days:       resultDays,
      totalDays:  resultDays.length,
      totalHours: Math.round(resultDays.reduce((s, d) => s + d.hours, 0) * 100) / 100,
    })
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors">
          <ChevronRight size={18} className="rotate-180" />
        </button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            In-app timesheet entry
            <span className="text-xs font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full">Beta</span>
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Add dates and entries directly in the browser.</p>
        </div>
      </div>

      {/* Stage issue summary */}
      {hasStageIssues && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
            <XCircle size={15} />
            {stageIssues.length} stage issue{stageIssues.length !== 1 ? 's' : ''} must be resolved before submitting
          </div>
          {stageIssues.map(({ e, de, warning }, i) => {
            const proj = projects.find(p => p.id === e.projectId)
            return (
              <p key={i} className="text-xs text-red-600 dark:text-red-400 ml-5">
                · <strong>{format(parseISO(de.date), 'MMM d')}</strong> — {proj?.name}: {warning}
              </p>
            )
          })}
        </div>
      )}

      {loadingProjects ? (
        <div className="card p-8 text-center text-sm text-gray-400">Loading your projects…</div>
      ) : projects.length === 0 ? (
        <div className="card p-8 text-center space-y-3">
          <Briefcase size={36} className="text-gray-300 dark:text-gray-700 mx-auto" />
          <p className="text-sm text-gray-500">You are not assigned to any active projects.</p>
          <p className="text-xs text-gray-400">Contact your project manager to be added to a project first.</p>
        </div>
      ) : (
        <>
          {/* Date entry cards */}
          <div className="space-y-4">
            {dateEntries.map((de, di) => (
              <DateCard
                key={de.id}
                de={de}
                projects={projects}
                onDateChange={d => setDate(de.id, d)}
                onAddEntry={() => addEntry(de.id)}
                onRemoveEntry={entryId => removeEntry(de.id, entryId)}
                onUpdateEntry={(entryId, field, value) => updateEntry(de.id, entryId, field, value)}
                onRemove={() => removeDate(de.id)}
                getStageWarning={getStageWarning}
                canRemove={dateEntries.length > 1}
              />
            ))}
          </div>

          <button onClick={addDate} className="btn-secondary w-full">
            <Plus size={15} /> Add date
          </button>

          {submitError && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              {submitError}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button onClick={onBack} className="btn-secondary">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={!isReady || submitting}
              className="btn-primary flex-1"
            >
              {submitting
                ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Submitting…</>
                : hasStageIssues
                  ? 'Fix stage issues to submit'
                  : !isReady
                    ? 'Fill in all required fields'
                    : <><CheckCircle size={15} /> Submit all</>
              }
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function DateCard({ de, projects, onDateChange, onAddEntry, onRemoveEntry, onUpdateEntry, onRemove, getStageWarning, canRemove }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-ae7-red flex-shrink-0" />
          <input
            type="date"
            value={de.date}
            onChange={e => onDateChange(e.target.value)}
            className="text-sm font-medium bg-transparent border-none outline-none dark:text-gray-100 cursor-pointer"
          />
        </div>
        {canRemove && (
          <button onClick={onRemove} className="text-gray-400 hover:text-red-500 p-1 rounded-lg transition-colors">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="divide-y divide-gray-50 dark:divide-gray-800/60">
        {de.entries.length === 0 && (
          <p className="text-xs text-gray-400 italic px-5 py-3">No entries yet. Click "Add Entry" below.</p>
        )}
        {de.entries.map(e => (
          <EntryRow
            key={e.id}
            entry={e}
            date={de.date}
            projects={projects}
            onUpdate={(field, value) => onUpdateEntry(e.id, field, value)}
            onRemove={() => onRemoveEntry(e.id)}
            getStageWarning={getStageWarning}
          />
        ))}
      </div>

      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
        <button onClick={onAddEntry} className="text-sm text-ae7-red hover:underline flex items-center gap-1">
          <Plus size={14} /> Add Entry
        </button>
      </div>
    </div>
  )
}

function EntryRow({ entry, date, projects, onUpdate, onRemove, getStageWarning }) {
  const selectedProject = projects.find(p => p.id === entry.projectId)
  const stages = selectedProject
    ? [...(selectedProject.project_stages || [])].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    : []
  const hours  = calcHours(entry.timeFrom, entry.timeTo)
  const warning = getStageWarning(entry, date)

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Project */}
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1 block">Project *</label>
          <select
            value={entry.projectId}
            onChange={e => onUpdate('projectId', e.target.value)}
            className="input text-sm"
          >
            <option value="">Select project…</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        {/* Stage */}
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1 block">Stage *</label>
          <select
            value={entry.stageId}
            onChange={e => onUpdate('stageId', e.target.value)}
            disabled={!entry.projectId}
            className={clsx('input text-sm', !entry.projectId && 'opacity-50 cursor-not-allowed')}
          >
            <option value="">Select stage…</option>
            {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {/* Stage warning */}
      {warning && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          {warning}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {/* Time from */}
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1 block">From *</label>
          <input type="time" value={entry.timeFrom} onChange={e => onUpdate('timeFrom', e.target.value)} className="input text-sm" />
        </div>

        {/* Time to */}
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1 block">To *</label>
          <input type="time" value={entry.timeTo} onChange={e => onUpdate('timeTo', e.target.value)} className="input text-sm" />
        </div>

        {/* Computed hours */}
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1 block">Hours</label>
          <div className="input text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {hours !== null ? `${hours}h` : '—'}
          </div>
        </div>
      </div>

      {/* Task/description + remove button */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="text-xs font-medium text-gray-500 mb-1 block">Task / Description</label>
          <input
            type="text"
            value={entry.task}
            onChange={e => onUpdate('task', e.target.value)}
            placeholder="Optional description"
            className="input text-sm"
          />
        </div>
        <button onClick={onRemove} className="p-2 rounded-xl text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors mb-0.5">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────
export default function UploadPage() {
  const { profile } = useAuth()
  if (!profile?.manager_ids?.length) return <ManagerGate />
  return <UploadPageInner profile={profile} />
}

function UploadPageInner({ profile }) {
  const navigate   = useNavigate()

  const [uploadMode, setUploadMode]   = useState('excel')   // 'excel' | 'inapp'
  const [inappResult, setInappResult] = useState(null)

  // Excel flow state
  const [file, setFile]           = useState(null)
  const [dragging, setDragging]   = useState(false)
  const [state, setState]         = useState('idle')  // 'idle'|'previewing'|'confirming'|'uploading'|'success'|'error'
  const [previewData, setPreview] = useState(null)
  const [result, setResult]       = useState(null)
  const [errorMsg, setErrorMsg]   = useState('')

  const accept = '.xlsx,.xls,.xlsm'

  function pickFile(f) {
    if (!f) return
    const ext = f.name.split('.').pop().toLowerCase()
    if (!['xlsx', 'xls', 'xlsm'].includes(ext)) { setErrorMsg('Please select an Excel file (.xlsx, .xls, or .xlsm).'); return }
    if (f.size > 10 * 1024 * 1024) { setErrorMsg('File must be under 10 MB.'); return }
    setFile(f); setErrorMsg(''); setState('idle')
  }

  const onDrop = useCallback((e) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files[0]) }, [])

  async function callApi(isDryRun) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Not authenticated')
    const base64 = await fileToBase64(file)
    const res = await fetch('/.netlify/functions/parse-timesheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ file: base64, fileName: file.name, dryRun: isDryRun }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Upload failed')
    return data
  }

  async function handlePreview() {
    if (!file) return
    setState('previewing'); setErrorMsg('')
    try { const data = await callApi(true); setPreview(data); setState('confirming') }
    catch (err) { setErrorMsg(err.message); setState('error') }
  }

  async function handleConfirm() {
    setState('uploading')
    try { const data = await callApi(false); setResult(data); setState('success') }
    catch (err) { setErrorMsg(err.message); setState('error') }
  }

  function handleReset() { setFile(null); setState('idle'); setPreview(null); setResult(null); setErrorMsg('') }

  // ── In-app success ───────────────────────────────────────────
  if (uploadMode === 'inapp' && inappResult) {
    return <SuccessScreen result={inappResult} onReset={() => { setInappResult(null); setUploadMode('excel') }} navigate={navigate} />
  }

  // ── In-app entry mode ────────────────────────────────────────
  if (uploadMode === 'inapp') {
    return (
      <InAppEntry
        profile={profile}
        onBack={() => setUploadMode('excel')}
        onSuccess={r => setInappResult(r)}
      />
    )
  }

  // ── Excel: success ───────────────────────────────────────────
  if (state === 'success' && result) {
    return <SuccessScreen result={result} onReset={handleReset} navigate={navigate} />
  }

  // ── Excel: confirmation ──────────────────────────────────────
  if (state === 'confirming' && previewData) {
    return <ConfirmationScreen preview={previewData} onConfirm={handleConfirm} onCancel={() => setState('idle')} confirming={false} />
  }
  if (state === 'uploading' && previewData) {
    return <ConfirmationScreen preview={previewData} onConfirm={handleConfirm} onCancel={() => setState('idle')} confirming={true} />
  }

  // ── Excel: upload form ───────────────────────────────────────
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Upload timesheet</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Upload your daily or weekly Excel timesheet file.
        </p>
      </div>

      <div className="card p-6 space-y-5">
        {/* Drop zone */}
        <div
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => document.getElementById('file-input').click()}
          className={clsx(
            'relative border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all',
            dragging
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
              : file
              ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/20'
              : 'border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-600 hover:bg-gray-50 dark:hover:bg-gray-800/30'
          )}
        >
          <input id="file-input" type="file" accept={accept} className="hidden" onChange={e => pickFile(e.target.files[0])} />
          {file ? (
            <>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setFile(null); setState('idle'); setErrorMsg('') }}
                className="absolute top-2 right-2 p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
              >
                <X size={15} />
              </button>
              <FileSpreadsheet size={36} className="text-emerald-500 mx-auto mb-3" />
              <p className="font-medium text-sm">{file.name}</p>
              <p className="text-xs text-gray-400 mt-1">{(file.size / 1024).toFixed(1)} KB · Click to change</p>
            </>
          ) : (
            <>
              <Upload size={36} className="text-gray-400 mx-auto mb-3" />
              <p className="font-medium text-sm">Drop your Excel file here</p>
              <p className="text-xs text-gray-400 mt-1">or click to browse · .xlsx, .xls, .xlsm · max 10 MB</p>
            </>
          )}
        </div>

        {/* Clock format note */}
        <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3">
          <AlertTriangle size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
            <strong>Use 24-hour clock format.</strong> Times like "09:00 – 17:00" are most accurate.
            AM/PM notation is supported but error-prone — e.g. "12:00 AM" vs "12:00 PM". Your file will be checked automatically.
          </p>
        </div>

        {/* Format hint */}
        <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
          <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Accepted formats</p>
          <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <li>• <strong>Standard weekly:</strong> Day / Date / Project / Stage / Total Hours / Time / Description columns</li>
            <li>• <strong>Multi-day:</strong> sections separated by "Date: YYYY-MM-DD" labels</li>
            <li>• <strong>Single-day legacy:</strong> any sheet with a date + Time / Project header row</li>
            <li>• Supported times: <strong>8:00–11:30</strong>, <strong>9:00 AM–5:00 PM</strong>, <strong>09:00–17:00</strong></li>
          </ul>
        </div>

        {errorMsg && (
          <div className="flex items-start gap-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl p-4">
            <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700 dark:text-red-400 flex-1">{errorMsg}</p>
            <button onClick={() => setErrorMsg('')} className="text-red-400 hover:text-red-600 flex-shrink-0"><X size={14} /></button>
          </div>
        )}

        <button onClick={handlePreview} disabled={!file || state === 'previewing'} className="btn-primary w-full">
          {state === 'previewing'
            ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Reading file…</>
            : <><Upload size={16} /> Submit timesheet</>
          }
        </button>
      </div>

      {/* Floating in-app beta button */}
      <button
        onClick={() => setUploadMode('inapp')}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium px-4 py-2.5 rounded-2xl shadow-lg hover:shadow-xl hover:scale-[1.03] transition-all"
      >
        <PlusCircle size={15} />
        Upload in-app
        <span className="text-xs font-semibold bg-amber-400 text-amber-900 px-1.5 py-0.5 rounded-full">Beta</span>
      </button>
    </div>
  )
}
