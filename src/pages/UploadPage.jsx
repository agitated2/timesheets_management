import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Upload, FileSpreadsheet, CheckCircle, AlertCircle, X, UserX,
  Calendar, ChevronDown, ChevronUp, AlertTriangle, XCircle,
  Plus, Trash2, Briefcase, ChevronRight, Maximize2, PenLine,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { canLogToStage, isStageSelectable } from '../lib/projectRules'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'
import { SkeletonList } from '../components/Skeleton'
import SidePanel from '../components/SidePanel'
import TimesheetPreview from '../components/TimesheetPreview'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Returns null for anything the DB would reject, so an invalid range
// simply reads as "no hours yet" and fails the isReady gate rather than
// silently producing a plausible-looking number.
//
// This deliberately does NOT wrap past midnight any more. It used to do
// `if (h < 0) h += 24`, making 22:00-02:00 a valid 4h entry — the
// entries_no_time_overlap trigger (migration v20) now rejects that, so
// wrapping here would compute hours for a row the database refuses.
// An overnight shift is entered as two entries, one on each day.
function calcHours(from, to) {
  if (!from || !to) return null
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  const h = (th + tm / 60) - (fh + fm / 60)
  if (h <= 0) return null
  return Math.round(h * 100) / 100
}

// Current wall-clock date + time in a given IANA zone, as plain strings —
// not a Date object, since what we need to compare against a DATE+TIME
// deadline is the office's own calendar date and clock time, not an
// instant. formatToParts is read by `type`, not string position, so the
// locale argument doesn't matter for correctness (only hour12 does).
function officeLocalNow(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]))
  // hour12:false can still yield "24" for midnight in some ICU
  // implementations — normalize so string comparison against "HH:MM"
  // deadlines stays correct.
  const hour = map.hour === '24' ? '00' : map.hour
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${hour}:${map.minute}` }
}

// '18:00:00' (Postgres TIME) → '6:00 PM' for display.
function formatDeadline12h(t) {
  if (!t) return null
  const [h, m] = t.split(':')
  const hour = Number(h)
  const period = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${m} ${period}`
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
                          {e.stage_name && <span className="text-gray-500 ml-2 text-xs">· {e.stage_name}</span>}
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

// ── Confirmation screen (Excel path) ──────────────────────────────
function ConfirmationScreen({ preview, onConfirm, onCancel, confirming }) {
  const {
    days, totalDays, totalHours,
    discrepancies = [], hasDiscrepancies = false,
    missingTasks = [], hasMissingTasks = false,
    projectViolations = [], hasProjectViolations = false,
    disciplineViolations = [], hasDisciplineViolations = false,
    leaveViolations = [], hasLeaveViolations = false,
    duplicateDayViolations = [], hasDuplicateDayViolations = false,
    overlapViolations = [], hasOverlapViolations = false,
    wrappedRangeViolations = [], hasWrappedRangeViolations = false,
  } = preview
  const blocked = hasDiscrepancies || hasMissingTasks || hasProjectViolations ||
    hasDisciplineViolations || hasLeaveViolations || hasDuplicateDayViolations ||
    hasOverlapViolations || hasWrappedRangeViolations
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
      case 'stage_required':
        return { title: `Select a stage for "${v.project}"`, body: 'Logging hours directly to a project isn’t allowed — every entry needs a stage.' }
      case 'stage_not_started':
        return { title: `Stage "${v.stage}" hasn’t opened yet`, body: `This stage starts on ${v.startDate ?? 'a later date'}. Contact your line manager.` }
      case 'stage_ended':
        return { title: `Stage "${v.stage}" has ended`, body: `This stage ended on ${v.endDate ?? 'its end date'}. You can only log work dated on or before that, unless the stage is extended.` }
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

        {/* ── Missing task descriptions ────────────────────── */}
        {hasMissingTasks && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {missingTasks.length} missing task description{missingTasks.length !== 1 ? 's' : ''}
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {missingTasks.map((m, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-800 dark:text-gray-200 truncate">
                        {m.project} · {format(parseISO(m.date), 'EEE MMM d')}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        Every entry needs a task description — this one is blank.
                      </p>
                    </div>
                    {m.rowNumber && (
                      <span className="text-xs font-mono bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-md flex-shrink-0 whitespace-nowrap">
                        Row {m.rowNumber}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Add a description for each entry in your Excel file and re-upload. Row numbers match the Excel display.
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

        {/* ── Discipline issues ────────────────────────────── */}
        {hasDisciplineViolations && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {disciplineViolations.length} discipline issue{disciplineViolations.length !== 1 ? 's' : ''}
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {disciplineViolations.map((v, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-800 dark:text-gray-200">
                        {v.type === 'discipline_not_found'
                          ? `Discipline "${v.discipline}" not found`
                          : 'Missing discipline'}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {v.type === 'discipline_not_found'
                          ? 'This discipline isn’t registered. Use an existing one or ask HR to add it.'
                          : 'Every entry must specify a discipline in the Discipline column.'}
                      </p>
                    </div>
                    {v.rowNumbers?.length > 0 && (
                      <span className="text-xs font-mono bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-md flex-shrink-0 whitespace-nowrap">
                        Row{v.rowNumbers.length > 1 ? 's' : ''} {v.rowNumbers.join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Add a valid Discipline for each entry in your Excel file and re-upload.
            </p>
          </div>
        )}

        {/* ── Duplicate-day conflicts ───────────────────────── */}
        {hasDuplicateDayViolations && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {duplicateDayViolations.length} date{duplicateDayViolations.length !== 1 ? 's' : ''} already submitted
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {duplicateDayViolations.map((v, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <p className="font-medium text-gray-800 dark:text-gray-200">{format(parseISO(v.date), 'EEE, MMM d, yyyy')}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    You already have a timesheet awaiting review for this date.
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              You can submit again for these dates only if your manager rejects the existing submission.
            </p>
          </div>
        )}

        {/* ── Wrapped / inverted time ranges ───────────────── */}
        {hasWrappedRangeViolations && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {wrappedRangeViolations.length} entr{wrappedRangeViolations.length !== 1 ? 'ies end' : 'y ends'} before {wrappedRangeViolations.length !== 1 ? 'they start' : 'it starts'}
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {wrappedRangeViolations.map((v, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-gray-800 dark:text-gray-200">
                      {format(parseISO(v.date), 'EEE, MMM d, yyyy')}
                      <span className="text-gray-500"> · {v.timeRange}</span>
                    </p>
                    {v.rowNumber && (
                      <span className="text-xs text-gray-400 flex-shrink-0">Row {v.rowNumber}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              An overnight shift must be split into one entry per day — e.g. 22:00–23:59 on the first day and 00:00–02:00 on the next.
            </p>
          </div>
        )}

        {/* ── Overlapping entries ──────────────────────────── */}
        {hasOverlapViolations && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {overlapViolations.length} overlapping time{overlapViolations.length !== 1 ? 's' : ''}
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {overlapViolations.map((v, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-gray-800 dark:text-gray-200">
                      {format(parseISO(v.date), 'EEE, MMM d, yyyy')}
                      <span className="text-gray-500"> · {v.rangeA} clashes with {v.rangeB}</span>
                    </p>
                    {v.rowNumbers?.length > 0 && (
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        Row{v.rowNumbers.length > 1 ? 's' : ''} {v.rowNumbers.join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Two entries on the same day can't cover the same clock time. Adjust the times and re-upload.
            </p>
          </div>
        )}

        {/* ── Leave conflicts ──────────────────────────────── */}
        {hasLeaveViolations && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              {leaveViolations.length} approved-leave conflict{leaveViolations.length !== 1 ? 's' : ''}
            </p>
            <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden divide-y divide-red-100 dark:divide-red-900/40">
              {leaveViolations.map((v, i) => (
                <div key={i} className="px-4 py-3 bg-red-50/60 dark:bg-red-950/20 text-sm">
                  <p className="font-medium text-gray-800 dark:text-gray-200">
                    {format(parseISO(v.date), 'EEE, MMM d, yyyy')}
                    {v.type === 'leave_hours' && v.timeRange && <span className="text-gray-500"> · {v.timeRange}</span>}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {v.type === 'leave_day'
                      ? 'You have an approved full-day leave on this date.'
                      : 'This entry overlaps an approved hourly leave.'}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              You have an approved leave for this date range. Please adjust your timesheet entries.
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
                              {e.stage_name && <span className="text-gray-500 ml-2 text-xs">· {e.stage_name}</span>}
                              {e.discipline_name && <span className="text-gray-500 ml-2 text-xs">· {e.discipline_name}</span>}
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

// ── Select field (combobox) ──────────────────────────────────────
// A plain <select>'s intrinsic width tracks its widest AVAILABLE option,
// not the one currently picked — fixed browser behavior, not something CSS
// can override. This is a button trigger that only ever renders the CURRENT
// value, so its width (and therefore the shared subgrid column's width)
// tracks what's actually selected instead of the worst case in the list.
// Popup height cap, kept in sync with the panel's max-h-56 class below —
// used to decide whether the panel has to open upward instead of down.
const SELECT_PANEL_MAX_HEIGHT = 224

// Below this, a search box is more clutter than help — a three-stage
// dropdown doesn't need one. Custom fields (which can carry hundreds of
// options, e.g. a building list) cross it immediately.
const SELECT_SEARCH_THRESHOLD = 8

function SelectField({ value, options, onChange, placeholder, disabled, className }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [search, setSearch] = useState('')
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const searchRef = useRef(null)
  const selected = options.find(o => o.id === value)

  const showSearch = options.length >= SELECT_SEARCH_THRESHOLD
  const q = search.trim().toLowerCase()
  const shownOptions = q ? options.filter(o => (o.name || '').toLowerCase().includes(q)) : options

  // Positioned `fixed` from the trigger's own screen rect, not `absolute`
  // inside this component — every row lives inside DateCard's `overflow-hidden`
  // card (needed for its rounded corners), which would clip an absolutely
  // positioned popup. `fixed` escapes that entirely, same trick SidePanel
  // uses to render above everything else.
  function openDropdown() {
    const rect = triggerRef.current.getBoundingClientRect()
    const openUp = rect.bottom + SELECT_PANEL_MAX_HEIGHT > window.innerHeight
      && rect.top > SELECT_PANEL_MAX_HEIGHT
    setPos({
      left: rect.left,
      width: rect.width,
      top: openUp ? undefined : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
    })
    setSearch('')
    setOpen(true)
  }

  // Focus the search box on open so a long list is type-to-filter without
  // an extra click. Deferred a frame — the panel isn't mounted yet at the
  // moment openDropdown() runs.
  useEffect(() => {
    if (open && showSearch) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, showSearch])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e) {
      if (triggerRef.current?.contains(e.target)) return
      if (panelRef.current?.contains(e.target)) return
      setOpen(false)
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    // The panel's position is computed once, on open — rather than tracking
    // scroll/resize live, just close it so it never sits somewhere stale.
    // `capture: true` so this also catches scrolling inside a nested
    // scrollable container, not just the window itself.
    function onScrollOrResize() { setOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  return (
    <div className={clsx('relative min-w-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={selected ? selected.name : placeholder}
        onClick={() => (open ? setOpen(false) : openDropdown())}
        className={clsx(
          'input group flex items-center gap-1.5 text-left min-w-0 w-full',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-gray-400 dark:hover:border-gray-500',
        )}
      >
        <span className={clsx('truncate min-w-0 flex-1', !selected && 'text-gray-400 dark:text-gray-500')}>
          {selected ? selected.name : placeholder}
        </span>
        <ChevronDown size={13} className="flex-shrink-0 text-gray-400" />
      </button>

      {open && pos && (
        <div
          ref={panelRef}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width }}
          className="fixed z-30 w-max max-w-[280px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg py-1 flex flex-col"
        >
          {/* Search sits OUTSIDE the scroll container so it stays put
              while the list below scrolls. */}
          {showSearch && (
            <div className="px-2 pb-1 pt-0.5 border-b border-gray-100 dark:border-gray-800">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-full text-sm px-2 py-1 rounded bg-gray-50 dark:bg-gray-800 border border-transparent focus:border-gray-300 dark:focus:border-gray-600 outline-none"
              />
            </div>
          )}
          <div className="max-h-56 overflow-y-auto">
            {options.length === 0 ? (
              <p className="px-3 py-1.5 text-sm text-gray-400 italic whitespace-nowrap">No options available</p>
            ) : shownOptions.length === 0 ? (
              <p className="px-3 py-1.5 text-sm text-gray-400 italic whitespace-nowrap">No matches</p>
            ) : (
              shownOptions.map(o => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o.id); setOpen(false) }}
                  className={clsx(
                    'block w-full text-left px-3 py-1.5 text-sm whitespace-nowrap hover:bg-gray-100 dark:hover:bg-gray-800',
                    o.id === value ? 'font-medium text-ae7-red' : 'text-gray-700 dark:text-gray-200',
                  )}
                >
                  {o.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Task cell ─────────────────────────────────────────────────────
// Fixed-height, single-line trigger that opens the editor drawer. It wears
// the plain `.input` class with NO line-height override, so it matches the
// height of every sibling field exactly — the old auto-growing textarea set
// `leading-snug` + `height = scrollHeight`, leaving it a few px short of the
// row at one line and dragging the row taller with every wrap.
function TaskCell({ value, placeholder, onOpen, className }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={value || placeholder}
      className={clsx(
        'input group flex items-center gap-2 text-left cursor-pointer min-w-0',
        'hover:border-gray-400 dark:hover:border-gray-500',
        'hover:bg-gray-50 dark:hover:bg-gray-800/70',
        className,
      )}
    >
      <span className={clsx('truncate flex-1 min-w-0', !value && 'text-gray-400 dark:text-gray-500')}>
        {value || placeholder}
      </span>
      <Maximize2
        size={13}
        className="flex-shrink-0 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </button>
  )
}

// Column template shared by the header row and every entry row. Each row
// is its own `grid-template-columns: subgrid` (Tailwind's `grid-cols-subgrid`)
// nested inside one parent grid (DateCard), so tracks size to the widest
// content actually present in that column — across the header AND every
// row — while staying aligned, instead of a hardcoded fr/px split.
// Project/Stage/Discipline use SelectField (not a native <select>) precisely
// so that content is the SELECTED value only: a native <select>'s intrinsic
// width is set by its widest available <option> regardless of which one is
// picked, which would make these columns static instead of dynamic.
// Their max is capped (`minmax(floor, cap)`, not `minmax(floor, auto)`) —
// an uncapped `auto` track has no upper bound and, unlike an `fr` track,
// never shrinks back below its content size, so one long name picked in
// any row would grow that column until the whole row overflows the card.
// SelectField's own truncate/ellipsis (see its `title` attr for the full
// value on hover) takes over once content exceeds the cap. Task is the
// only flexible track, so it absorbs/gives up whatever space the capped
// columns don't claim — its floor is 90px, NOT 0: `minmax(0,1fr)` lets the
// TRACK shrink to nothing, but TaskCell's button still needs room for its
// padding + icon once its text has truncated down to nothing, and those
// can't compress further. Below that track floor the button's own
// irreducible width would exceed what the track allocated it, and it
// overflows rightward into the Hours cell next to it — not a shrink, a
// visible overlap. Applied via inline style (not a Tailwind class) since
// `minmax()` argument commas don't survive Tailwind's arbitrary-value
// parsing.
// The custom-field track (migration_v21) sits right after Discipline, but
// only EXISTS when something in this day actually uses it — a project
// with no custom fields gets the original 8-column layout with no
// reserved gap. entryGridCols() builds the template both ways, and
// DateCard/EntryRow agree on which one via the same `hasCustomColumn`
// flag, so the header, every row, and the track list never disagree
// about how many cells there are.
//
// It's narrower than Project/Stage on purpose: it holds short values like
// a building number.
//
// ONE track, not one per field, because the field SET varies per row —
// two rows on different stages can carry different fields entirely, and a
// shared subgrid header can't label a column that means "Building" on one
// row and "Zone" on the next. Multiple fields on a single row stack
// inside this one cell instead.
const ENTRY_GRID_HEAD = 'minmax(110px,220px) minmax(90px,160px) minmax(90px,160px)'
const ENTRY_GRID_CUSTOM = 'minmax(84px,132px)'
const ENTRY_GRID_TAIL = 'minmax(96px,auto) minmax(96px,auto) minmax(90px,1fr) minmax(68px,auto) 32px'

function entryGridCols(hasCustomColumn) {
  return hasCustomColumn
    ? `${ENTRY_GRID_HEAD} ${ENTRY_GRID_CUSTOM} ${ENTRY_GRID_TAIL}`
    : `${ENTRY_GRID_HEAD} ${ENTRY_GRID_TAIL}`
}

// ── In-App Entry ─────────────────────────────────────────────────
function InAppEntry({ profile, xlsxEnabled, onSwitchToExcel, onSuccess }) {
  const [projects, setProjects]       = useState([])
  const [disciplines, setDisciplines] = useState([])
  const [loadingProjects, setLoading] = useState(true)
  const [dateEntries, setDateEntries] = useState([newDateEntry()])
  const [previewing, setPreviewing]   = useState(false)
  const [checkingDup, setCheckingDup] = useState(false)
  const [dupError, setDupError]       = useState('')
  const [submitting, setSubmitting]   = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [office, setOffice]           = useState(null)  // { name, timezone, timesheet_deadline }
  // Custom fields (migration_v21). Loaded once for the whole form rather
  // than per row: the assignment set is small, and every row needs to
  // resolve against it as soon as its stage changes.
  const [customFields, setCustomFields] = useState([])       // { id, name }[]
  const [fieldOptions, setFieldOptions] = useState({})       // field_id -> option[]
  const [fieldAssignments, setFieldAssignments] = useState([])

  useEffect(() => {
    if (!profile?.office_id) return
    supabase.from('offices').select('name, timezone, timesheet_deadline').eq('id', profile.office_id).single()
      .then(({ data }) => setOffice(data))
  }, [profile?.office_id])

  useEffect(() => {
    async function load() {
      const { data: disc } = await supabase.from('disciplines').select('id, name').eq('is_active', true).order('name')
      setDisciplines(disc || [])
      const { data: members } = await supabase
        .from('project_members')
        .select('project_id')
        .eq('employee_id', profile.id)
      const ids = (members || []).map(m => m.project_id)
      if (ids.length === 0) { setLoading(false); return }
      const [{ data: projs }, { data: stages }] = await Promise.all([
        supabase.from('projects').select('id, name, tracking_type, total_hours').in('id', ids).eq('status', 'active').order('name'),
        supabase.from('project_stages_view').select('*').in('project_id', ids),
      ])
      const byProject = {}
      ;(stages || []).forEach(s => { (byProject[s.project_id] ||= []).push(s) })
      setProjects((projs || []).map(p => ({ ...p, project_stages: byProject[p.id] || [] })))

      // Custom fields for the projects this employee can log against.
      // Archived options are excluded here rather than filtered at render
      // time so a retired option can never be picked on a NEW entry,
      // while existing values keep resolving through their own FK.
      const [{ data: cf }, { data: cfOpts }, { data: cfAssign }] = await Promise.all([
        supabase.from('custom_fields').select('id, name').eq('is_active', true).order('name'),
        supabase.from('custom_field_options').select('id, field_id, label, is_na_sentinel, is_archived')
          .eq('is_archived', false).order('sort_order'),
        supabase.from('custom_field_assignments').select('field_id, project_id, stage_id, requirement').in('project_id', ids),
      ])
      setCustomFields(cf || [])
      const optsByField = {}
      ;(cfOpts || []).forEach(o => { (optsByField[o.field_id] ||= []).push(o) })
      setFieldOptions(optsByField)
      setFieldAssignments(cfAssign || [])

      setLoading(false)
    }
    load()
  }, [profile.id])

  // Which fields apply to a stage, and how. Mirrors the fields_for_stage()
  // SQL helper from migration_v21 — most specific wins, so a stage-level
  // assignment overrides the project-level one, and 'disabled' rows are
  // dropped here (the assignment UI needs to see them; the entry form
  // does not).
  const fieldsForStage = useCallback((projectId, stageId) => {
    if (!projectId || !stageId) return []
    const relevant = fieldAssignments.filter(a =>
      a.project_id === projectId && (a.stage_id === stageId || a.stage_id === null)
    )
    const resolved = new Map()
    for (const a of relevant) {
      const existing = resolved.get(a.field_id)
      // A stage-specific row always beats the project-level fallback.
      if (!existing || (existing.stage_id === null && a.stage_id !== null)) {
        resolved.set(a.field_id, a)
      }
    }
    return [...resolved.values()]
      .filter(a => a.requirement !== 'disabled')
      .map(a => {
        const field = customFields.find(f => f.id === a.field_id)
        return field ? { ...field, requirement: a.requirement, options: fieldOptions[a.field_id] || [] } : null
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [fieldAssignments, customFields, fieldOptions])

  function newDateEntry() {
    return { id: crypto.randomUUID(), date: format(new Date(), 'yyyy-MM-dd'), entries: [] }
  }
  // Carries Project/Stage/Discipline over from the previous row (time and
  // task left blank) — the common pattern of logging several tasks against
  // the same project/stage back to back. Falls back to the employee's home
  // discipline when there's no previous row to carry from.
  function newEntry(carryFrom) {
    return {
      id: crypto.randomUUID(),
      projectId:    carryFrom?.projectId    || '',
      stageId:      carryFrom?.stageId      || '',
      disciplineId: carryFrom?.disciplineId || profile?.discipline_id || '',
      timeFrom: '', timeTo: '', task: '',
      // field_id -> option_id. Carried over with project/stage, since a
      // row cloned from the one above is usually the same building/zone
      // too — the same reasoning that carries project and stage.
      customValues: { ...(carryFrom?.customValues || {}) },
    }
  }

  function addDate() { setDateEntries(prev => [...prev, newDateEntry()]) }
  function removeDate(id) { setDateEntries(prev => prev.filter(d => d.id !== id)) }
  function setDate(id, date) { setDateEntries(prev => prev.map(d => d.id === id ? { ...d, date } : d)) }
  function addEntry(dateId) {
    setDateEntries(prev => prev.map(d => {
      if (d.id !== dateId) return d
      const last = d.entries[d.entries.length - 1]
      return { ...d, entries: [...d.entries, newEntry(last)] }
    }))
  }
  function removeEntry(dateId, entryId) {
    setDateEntries(prev => prev.map(d => d.id === dateId ? { ...d, entries: d.entries.filter(e => e.id !== entryId) } : d))
  }
  function updateEntry(dateId, entryId, field, value) {
    setDateEntries(prev => prev.map(d =>
      d.id === dateId
        ? {
            ...d,
            entries: d.entries.map(e => {
              if (e.id !== entryId) return e
              // Changing project or stage changes which custom fields
              // apply, so any value collected under the old stage is
              // meaningless — clear rather than carry a value for a field
              // that may not even be assigned here.
              const resetCustom = (field === 'projectId' || field === 'stageId') ? { customValues: {} } : {}
              return {
                ...e,
                [field]: value,
                ...(field === 'projectId' ? { stageId: '' } : {}),
                ...resetCustom,
              }
            }),
          }
        : d
    ))
  }

  // field_id -> option_id, on one entry.
  function updateEntryCustomValue(dateId, entryId, fieldId, optionId) {
    setDateEntries(prev => prev.map(d =>
      d.id === dateId
        ? {
            ...d,
            entries: d.entries.map(e =>
              e.id === entryId
                ? { ...e, customValues: { ...e.customValues, [fieldId]: optionId } }
                : e
            ),
          }
        : d
    ))
  }

  function ruleStage(stage) {
    return {
      startDate: stage.start_date,
      endDate:   stage.end_date,
    }
  }

  // Blocking issue: stage not open yet, or ended (unless extended).
  function getStageWarning(entry, date) {
    if (!entry.projectId || !entry.stageId || !date) return null
    const proj  = projects.find(p => p.id === entry.projectId)
    const stage = proj?.project_stages?.find(s => s.id === entry.stageId)
    if (!stage) return null
    const rs = ruleStage(stage)

    const verdict = canLogToStage(rs, date)
    if (!verdict.ok) {
      if (verdict.reason === 'not_started')
        return `Stage "${stage.name}" hasn't opened yet — contact your line manager.`
      if (verdict.reason === 'ended')
        return `Stage "${stage.name}" ended on ${stage.end_date}. You can only log work dated on or before that, unless the stage is extended.`
      return `Stage "${stage.name}" can't be logged for this date.`
    }

    return null
  }

  // Collect all stage warnings across all entries
  const stageIssues = dateEntries.flatMap(de =>
    de.entries
      .map(e => ({ e, de, warning: getStageWarning(e, de.date) }))
      .filter(({ warning }) => !!warning)
  )

  const hasStageIssues = stageIssues.length > 0

  // Overlapping-time guard. The entries_no_time_overlap trigger
  // (migration v20) is the real guarantee; this exists so the offending
  // rows are marked inline instead of the whole submit failing with one
  // Postgres error naming a single pair.
  //
  // Returns a Set of entry ids involved in ANY overlap within their own
  // day — both sides get flagged, since neither is more "wrong" than the
  // other. Half-open comparison: adjacency (10:00 to 10:00) is fine.
  const overlappingEntryIds = useMemo(() => {
    const bad = new Set()
    for (const de of dateEntries) {
      const timed = de.entries.filter(e => e.timeFrom && e.timeTo)
      for (let i = 0; i < timed.length; i++) {
        for (let j = i + 1; j < timed.length; j++) {
          const a = timed[i], b = timed[j]
          if (a.timeFrom < b.timeTo && a.timeTo > b.timeFrom) {
            bad.add(a.id)
            bad.add(b.id)
          }
        }
      }
    }
    return bad
  }, [dateEntries])

  const hasOverlaps = overlappingEntryIds.size > 0

  // A field assigned as 'required' must have a value — but N/A counts as
  // a value (it's a real option, see migration_v21), so choosing "not
  // applicable" satisfies the requirement. That's the whole point of the
  // sentinel: "required" means "make a decision", not "must be non-empty".
  function missingRequiredFields(entry) {
    return fieldsForStage(entry.projectId, entry.stageId)
      .filter(f => f.requirement === 'required' && !entry.customValues?.[f.id])
  }

  const isReady = !hasStageIssues && !hasOverlaps &&
    dateEntries.length > 0 &&
    dateEntries.every(de =>
      de.date && de.entries.length > 0 &&
      // calcHours returns null for an inverted/zero-length range (it no
      // longer wraps past midnight), so this also gates those out.
      de.entries.every(e =>
        e.projectId && e.stageId && e.timeFrom && e.timeTo && e.task?.trim() && e.disciplineId &&
        calcHours(e.timeFrom, e.timeTo) !== null &&
        missingRequiredFields(e).length === 0
      )
    )

  // Duplicate-day guard: catches both a repeated date within this same
  // submission, and a date that already has a pending/approved timesheet.
  // The DB's partial unique index is the real guarantee (caught below too,
  // in case of a race) — this is just so the employee sees it clearly and
  // before wasting a step on the preview screen.
  async function handlePreviewClick() {
    setDupError('')
    const dates = dateEntries.map(d => d.date).filter(Boolean)
    const seen = new Set()
    const withinDupe = dates.find(d => seen.has(d) || !seen.add(d))
    if (withinDupe) {
      setDupError(`${format(parseISO(withinDupe), 'MMM d, yyyy')} is entered more than once above — each date can only appear once.`)
      return
    }
    // Overlapping times within a day. Reported here as well as inline
    // per-row, so clicking through to preview with an overlap present
    // gives a reason rather than a disabled button with no explanation.
    const overlapDay = dateEntries.find(de =>
      de.entries.some(e => overlappingEntryIds.has(e.id))
    )
    if (overlapDay) {
      setDupError(`Two or more entries on ${format(parseISO(overlapDay.date), 'MMM d, yyyy')} cover overlapping times. Adjust them so they don't clash.`)
      return
    }
    // Compared against the OFFICE's today, not the browser's — the two
    // differ for several hours a day. The timesheets_block_future trigger
    // is the real guarantee (and is what a tampered client would hit);
    // this just surfaces it before the preview step. Skipped entirely if
    // the office hasn't loaded yet, rather than falling back to browser
    // time and rejecting a legitimate same-day entry.
    if (officeNow) {
      const future = dates.find(d => d > officeNow.date)
      if (future) {
        setDupError(`${format(parseISO(future), 'MMM d, yyyy')} is in the future. Timesheets can only be submitted for today or earlier.`)
        return
      }
    }
    setCheckingDup(true)
    const { data: existing } = await supabase
      .from('timesheets')
      .select('date')
      .eq('employee_id', profile.id)
      .in('date', dates)
      .in('status', ['pending', 'approved'])
    setCheckingDup(false)
    if (existing?.length) {
      const conflictDates = existing.map(e => format(parseISO(e.date), 'MMM d, yyyy')).join(', ')
      setDupError(`You already have a timesheet awaiting review for ${conflictDates}. You can submit again only if your manager rejects it.`)
      return
    }
    setPreviewing(true)
  }

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

      if (tsErr) {
        setSubmitting(false)
        if (tsErr.code === '23505') {
          setPreviewing(false)
          setSubmitError(`You already have a timesheet awaiting review for ${format(parseISO(de.date), 'MMM d, yyyy')}. You can submit again only if your manager rejects it.`)
        } else {
          setSubmitError(tsErr.message)
        }
        return
      }

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
          project_id:    proj?.id    || null,
          stage_id:      stage?.id   || null,
          stage_name:    stage?.name || null,   // display only — stripped before insert
          discipline_id: e.disciplineId || null,
          task:          e.task?.trim() || null,
        }
      })

      // .select() so the inserted ids come back — the custom field values
      // below need them. A single multi-row INSERT ... RETURNING yields
      // rows in the order supplied, so index alignment with `de.entries`
      // holds.
      const { data: insertedEntries, error: entErr } = await supabase
        .from('timesheet_entries')
        .insert(entries.map(({ stage_name, ...e }) => e))
        .select('id')
      if (entErr) {
        // Roll back the just-created timesheet so a leave-blocked entry
        // (or any failure) never leaves an empty timesheet behind.
        await supabase.from('timesheets').delete().eq('id', ts.id)
        setSubmitting(false)
        setSubmitError(entErr.message)
        return
      }

      // Custom field values (migration_v21). option_label_snapshot is
      // filled server-side by the entry_field_values_snapshot trigger, so
      // it's deliberately not sent from here — a client-supplied label
      // could disagree with the option it points at.
      const fieldValueRows = []
      de.entries.forEach((e, i) => {
        const entryId = insertedEntries?.[i]?.id
        if (!entryId) return
        for (const [fieldId, optionId] of Object.entries(e.customValues || {})) {
          if (optionId) fieldValueRows.push({ entry_id: entryId, field_id: fieldId, option_id: optionId })
        }
      })

      if (fieldValueRows.length > 0) {
        const { error: cvErr } = await supabase.from('timesheet_entry_field_values').insert(fieldValueRows)
        if (cvErr) {
          // Same rollback reasoning as above — a timesheet whose entries
          // are missing their custom values is worse than no timesheet,
          // because the gap is invisible once submitted.
          await supabase.from('timesheets').delete().eq('id', ts.id)
          setSubmitting(false)
          setSubmitError(cvErr.message)
          return
        }
      }

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

  // ── Preview step ─────────────────────────────────────────────
  if (previewing) {
    const grandTotal = dateEntries.reduce((s, de) =>
      s + de.entries.reduce((s2, e) => s2 + (calcHours(e.timeFrom, e.timeTo) || 0), 0), 0)

    return (
      <div className="max-w-2xl space-y-5">
        <div className="flex items-center gap-3">
          <button onClick={() => setPreviewing(false)} disabled={submitting} className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors">
            <ChevronRight size={18} className="rotate-180" />
          </button>
          <div>
            <h1 className="page-title">Preview submission</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">This is exactly what your manager will see.</p>
          </div>
        </div>

        <div className="space-y-4">
          {dateEntries.map(de => {
            const dayHours = de.entries.reduce((s, e) => s + (calcHours(e.timeFrom, e.timeTo) || 0), 0)
            const previewEntries = de.entries.map(e => {
              const proj  = projects.find(p => p.id === e.projectId)
              const stage = proj?.project_stages?.find(s => s.id === e.stageId)
              const disc  = disciplines.find(d => d.id === e.disciplineId)
              return {
                time_from: e.timeFrom, time_to: e.timeTo,
                hours_decimal: calcHours(e.timeFrom, e.timeTo),
                project_name: proj?.name, stage_name: stage?.name,
                discipline_name: disc?.name, task: e.task,
              }
            })
            return (
              <div key={de.id} className="card overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30 flex items-center justify-between">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <Calendar size={14} className="text-ae7-red" />
                    {format(parseISO(de.date), 'EEEE, MMM d, yyyy')}
                  </span>
                  <span className="text-xs text-gray-400">{dayHours.toFixed(2)}h</span>
                </div>
                <TimesheetPreview entries={previewEntries} showTotal={false} />
              </div>
            )
          })}
        </div>

        <p className="text-xs text-gray-400 text-center">
          {dateEntries.length > 1
            ? `This will create ${dateEntries.length} separate timesheet submissions — one per day, each reviewed independently. Total: ${grandTotal.toFixed(2)}h`
            : `Your manager will be notified to review this timesheet. Total: ${grandTotal.toFixed(2)}h`}
        </p>

        {submitError && (
          <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            {submitError}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button onClick={() => setPreviewing(false)} disabled={submitting} className="btn-secondary flex-1">
            Back to editing
          </button>
          <button onClick={handleSubmit} disabled={submitting} className="btn-primary flex-1">
            {submitting
              ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Submitting…</>
              : <><CheckCircle size={15} /> Confirm &amp; Submit</>
            }
          </button>
        </div>
      </div>
    )
  }

  // Deadline is informational only — reporting rule, not a submission
  // gate. It's evaluated against the OFFICE's local clock, not the
  // browser's, same reasoning as everywhere else timezone matters here.
  const officeNow = office ? officeLocalNow(office.timezone) : null
  const isPastDeadlineToday = officeNow && office?.timesheet_deadline
    && officeNow.time >= office.timesheet_deadline.slice(0, 5)
  const enteringForToday = officeNow && dateEntries.some(de => de.date === officeNow.date)

  // ── Editing step ─────────────────────────────────────────────
  // Wider than the rest of the app's max-w-4xl pages: the entry grid now
  // carries nine tracks (custom fields added a column), and at 4xl the
  // Task column gets squeezed to its 90px floor as soon as a project with
  // custom fields is picked.
  return (
    <div className="max-w-6xl space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">Upload timesheet</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Add your entries for each date below.
            {office?.timesheet_deadline && (
              <> Daily deadline: <strong>{formatDeadline12h(office.timesheet_deadline)}</strong> ({office.timezone}).</>
            )}
          </p>
        </div>
        {xlsxEnabled && (
          <button onClick={onSwitchToExcel} className="text-sm text-gray-500 hover:text-ae7-red flex items-center gap-1.5 transition-colors">
            <FileSpreadsheet size={14} /> Upload an Excel file instead
          </button>
        )}
      </div>

      {/* Past-deadline notice — informational, never blocks submission */}
      {isPastDeadlineToday && enteringForToday && (
        <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-xl px-3 py-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          It's currently past today's {formatDeadline12h(office.timesheet_deadline)} deadline — a timesheet submitted now for today will be recorded as late.
        </div>
      )}

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
        <div className="card overflow-hidden"><SkeletonList rows={4} /></div>
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
                disciplines={disciplines}
                onDateChange={d => setDate(de.id, d)}
                onAddEntry={() => addEntry(de.id)}
                onRemoveEntry={entryId => removeEntry(de.id, entryId)}
                onUpdateEntry={(entryId, field, value) => updateEntry(de.id, entryId, field, value)}
                onRemove={() => removeDate(de.id)}
                getStageWarning={getStageWarning}
                canRemove={dateEntries.length > 1}
                maxDate={officeNow?.date}
                overlappingEntryIds={overlappingEntryIds}
                fieldsForStage={fieldsForStage}
                onUpdateCustomValue={(entryId, fieldId, optionId) => updateEntryCustomValue(de.id, entryId, fieldId, optionId)}
              />
            ))}
          </div>

          <button onClick={addDate} className="btn-secondary w-full">
            <Plus size={15} /> Add date
          </button>

          {dupError && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              {dupError}
            </div>
          )}
          {submitError && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              {submitError}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handlePreviewClick}
              disabled={!isReady || checkingDup}
              className="btn-primary flex-1"
            >
              {checkingDup
                ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Checking…</>
                : hasStageIssues
                  ? 'Fix stage issues to submit'
                  : !isReady
                    ? 'Fill in all required fields'
                    : <><Calendar size={15} /> Preview &amp; Submit</>
              }
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function DateCard({ de, projects, disciplines, onDateChange, onAddEntry, onRemoveEntry, onUpdateEntry, onRemove, getStageWarning, canRemove, maxDate, overlappingEntryIds, fieldsForStage, onUpdateCustomValue }) {
  // maxDate is the OFFICE's today, not the browser's — see officeLocalNow.
  // This only stops the picker offering future days; the real guarantee is
  // the timesheets_block_future trigger (migration_v17), which also covers
  // the XLSX importer.
  const isFuture = maxDate && de.date > maxDate

  // The custom-field column only exists if something in THIS day uses it,
  // so a project without custom fields keeps the original layout and no
  // blank track. Its header is the field's own name when every row
  // resolves to the same single field — the normal case, and far more
  // useful than a generic word — falling back to "Details" only when a day
  // mixes stages carrying different fields.
  const { hasCustomColumn, customFieldHeader } = useMemo(() => {
    if (!fieldsForStage) return { hasCustomColumn: false, customFieldHeader: '' }
    const names = new Set()
    let sawMultiple = false
    for (const e of de.entries) {
      const fields = fieldsForStage(e.projectId, e.stageId)
      if (fields.length > 1) sawMultiple = true
      fields.forEach(f => names.add(f.name))
    }
    if (names.size === 0) return { hasCustomColumn: false, customFieldHeader: '' }
    return {
      hasCustomColumn: true,
      customFieldHeader: names.size === 1 && !sawMultiple ? [...names][0] : 'Details',
    }
  }, [de.entries, fieldsForStage])

  const headerLabels = hasCustomColumn
    ? ['Project', 'Stage', 'Discipline', customFieldHeader, 'From', 'To', 'Task', 'Hours']
    : ['Project', 'Stage', 'Discipline', 'From', 'To', 'Task', 'Hours']

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-ae7-red flex-shrink-0" />
          <input
            type="date"
            value={de.date}
            max={maxDate || undefined}
            onChange={e => onDateChange(e.target.value)}
            className="text-sm font-medium bg-transparent border-none outline-none dark:text-gray-100 cursor-pointer"
          />
          {isFuture && (
            <span className="text-xs text-red-600 dark:text-red-400 font-medium">
              Future date — not allowed
            </span>
          )}
        </div>
        {canRemove && (
          <button onClick={onRemove} className="text-gray-400 hover:text-red-500 p-1 rounded-lg transition-colors">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {de.entries.length === 0 ? (
        <p className="text-xs text-gray-400 italic px-5 py-3">No entries yet. Click "Add row" below.</p>
      ) : (
        // One grid spans the header + every row (each row is `grid-cols-subgrid`,
        // see EntryRow) so `auto`-sized columns are computed across all of them
        // together and stay aligned — a separate grid per row can't do that,
        // each would size its own columns independently.
        <div className="px-5 sm:grid sm:gap-x-3" style={{ gridTemplateColumns: entryGridCols(hasCustomColumn) }}>
          {/* Column header (desktop only). Trailing span is the spacer for
              the remove-button track. */}
          {headerLabels.map((label, i) => (
            <span key={i} className="hidden sm:block pt-3 pb-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider truncate">
              {label}
            </span>
          ))}
          <span className="hidden sm:block" />

          {de.entries.map((e, idx) => (
            <EntryRow
              key={e.id}
              entry={e}
              date={de.date}
              projects={projects}
              disciplines={disciplines}
              onUpdate={(field, value) => onUpdateEntry(e.id, field, value)}
              onRemove={() => onRemoveEntry(e.id)}
              getStageWarning={getStageWarning}
              isFirst={idx === 0}
              isOverlapping={overlappingEntryIds?.has(e.id)}
              customFields={fieldsForStage ? fieldsForStage(e.projectId, e.stageId) : []}
              hasCustomColumn={hasCustomColumn}
              onUpdateCustomValue={(fieldId, optionId) => onUpdateCustomValue?.(e.id, fieldId, optionId)}
            />
          ))}
        </div>
      )}

      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
        <button onClick={onAddEntry} className="text-sm text-ae7-red hover:underline flex items-center gap-1">
          <Plus size={14} /> Add row
        </button>
      </div>
    </div>
  )
}

function EntryRow({ entry, date, projects, disciplines, onUpdate, onRemove, getStageWarning, isFirst, isOverlapping, customFields = [], hasCustomColumn = false, onUpdateCustomValue }) {
  const selectedProject = projects.find(p => p.id === entry.projectId)
  const stages = selectedProject
    ? [...(selectedProject.project_stages || [])]
        .filter(s => !s.is_archived)
        .filter(s => isStageSelectable({
          startDate: s.start_date,
          endDate:   s.end_date,
        }, date))
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    : []
  const hours   = calcHours(entry.timeFrom, entry.timeTo)
  const warning = getStageWarning(entry, date)
  const [taskOpen, setTaskOpen] = useState(false)

  // calcHours returns null for an inverted or zero-length range now that
  // it no longer wraps past midnight — surface that as its own message
  // rather than leaving the Hours cell showing a bare "—".
  const badRange = entry.timeFrom && entry.timeTo && hours === null

  // The drawer covers the grid, so name the row it belongs to.
  const selectedStage = stages.find(s => s.id === entry.stageId)
  const taskContext = [
    selectedProject?.name,
    selectedStage?.name,
    date ? format(parseISO(date), 'dd MMM yyyy') : null,
  ].filter(Boolean).join(' · ')

  return (
    // `grid-cols-subgrid` at sm+ inherits the parent DateCard grid's column
    // tracks (see entryGridCols) instead of defining its own, so this row's
    // cells size and align together with every other row and the header.
    // Below sm it's an ordinary 2-col grid, independent of the parent (which
    // isn't a grid at all on mobile) — the stacked label/value layout is
    // unchanged.
    <div
      className={clsx(
        'grid grid-cols-2 sm:grid-cols-subgrid sm:col-span-full gap-x-3 gap-y-3 sm:gap-y-2 items-start py-3',
        !isFirst && 'border-t border-gray-50 dark:border-gray-800/60',
      )}
    >
        <div className="col-span-2 sm:hidden text-xs font-medium text-gray-500">Project *</div>
        <SelectField
          value={entry.projectId}
          options={projects}
          onChange={v => onUpdate('projectId', v)}
          placeholder="Project…"
        />

        <div className="col-span-2 sm:hidden text-xs font-medium text-gray-500">Stage *</div>
        <SelectField
          value={entry.stageId}
          options={stages}
          onChange={v => onUpdate('stageId', v)}
          placeholder="Stage…"
          disabled={!entry.projectId}
        />

        <div className="col-span-2 sm:hidden text-xs font-medium text-gray-500">Discipline *</div>
        <SelectField
          value={entry.disciplineId || ''}
          options={disciplines}
          onChange={v => onUpdate('disciplineId', v)}
          placeholder="Discipline…"
        />

        {/* Custom fields (migration_v21) — one grid cell, however many
            fields apply. The field name is the placeholder rather than a
            separate label, matching Project…/Stage…/Discipline… above, so
            the control is self-describing without adding a label row and
            growing every entry.
            The whole column is omitted (not just left empty) when nothing
            in this day uses it — see entryGridCols. When the column DOES
            exist but this particular row has no fields, the cell still has
            to be emitted, or every column after it shifts left on that
            row only — rendered as a muted, non-interactive box rather than
            an invisible spacer, so the row reads as a table cell that
            doesn't apply here instead of a hole in the layout. Same
            treatment the Hours cell already uses when it has no value.
            Desktop only: on mobile there are no shared tracks to keep
            aligned, so a placeholder there would just be noise. */}
        {customFields.length > 0 && (
          <div className="col-span-2 sm:hidden text-xs font-medium text-gray-500">
            {customFields.map(f => f.name).join(' · ')}
          </div>
        )}
        {hasCustomColumn && customFields.length === 0 ? (
          <div
            title="No custom fields for this stage"
            className="input hidden sm:flex items-center justify-center text-sm text-gray-300 dark:text-gray-600 bg-gray-50/60 dark:bg-gray-800/30 select-none"
          >
            —
          </div>
        ) : customFields.length === 0 ? null : (
          <div className="col-span-2 sm:col-span-1 space-y-1.5 min-w-0">
            {customFields.map(f => {
              const naOption = f.options.find(o => o.is_na_sentinel)
              const rest = f.options.filter(o => !o.is_na_sentinel)
              // N/A first, then the real options — mirrors sort_order = -1
              // on the sentinel, and keeps "not applicable" a one-click
              // choice rather than something to scroll past.
              const opts = [
                ...(naOption ? [{ id: naOption.id, name: naOption.label }] : []),
                ...rest.map(o => ({ id: o.id, name: o.label })),
              ]
              const value = entry.customValues?.[f.id] || ''
              const unset = f.requirement === 'required' && !value
              return (
                <SelectField
                  key={f.id}
                  value={value}
                  options={opts}
                  onChange={v => onUpdateCustomValue?.(f.id, v)}
                  placeholder={f.requirement === 'required' ? `${f.name} *` : `${f.name}…`}
                  className={clsx(unset && '[&>button]:border-red-300 dark:[&>button]:border-red-800')}
                />
              )
            })}
          </div>
        )}

        <div className="sm:hidden text-xs font-medium text-gray-500">From *</div>
        <input type="time" value={entry.timeFrom} onChange={e => onUpdate('timeFrom', e.target.value)} className="input text-sm" />

        <div className="sm:hidden text-xs font-medium text-gray-500">To *</div>
        <input type="time" value={entry.timeTo} onChange={e => onUpdate('timeTo', e.target.value)} className="input text-sm" />

        <div className="col-span-2 sm:hidden text-xs font-medium text-gray-500">Task / Description *</div>
        <TaskCell
          value={entry.task}
          placeholder="What did you work on?"
          onOpen={() => setTaskOpen(true)}
          className="col-span-2 sm:col-span-1"
        />

        <div className="sm:hidden text-xs font-medium text-gray-500">Hours</div>
        <div className="input text-sm text-gray-500 dark:text-gray-400 flex items-center justify-center">
          {hours !== null ? `${hours}h` : '—'}
        </div>

        <button
          onClick={onRemove}
          className="justify-self-end sm:justify-self-auto p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
          title="Remove row"
        >
          <Trash2 size={15} />
        </button>

        {/* Stage warning (blocking) */}
        {warning && (
          <div className="col-span-full flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            {warning}
          </div>
        )}

        {/* Invalid range — "to" at or before "from" (blocking) */}
        {badRange && (
          <div className="col-span-full flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            This entry must end after it starts. For an overnight shift, add one entry on each day.
          </div>
        )}

        {/* Overlapping time (blocking) */}
        {isOverlapping && !badRange && (
          <div className="col-span-full flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            This entry's time overlaps another entry on the same day.
          </div>
        )}

      {taskOpen && (
        <SidePanel
          title="Task / Description"
          subtitle={taskContext || undefined}
          icon={<PenLine size={15} className="text-ae7-red flex-shrink-0" />}
          onClose={() => setTaskOpen(false)}
          footer={
            <button onClick={() => setTaskOpen(false)} className="btn-primary w-full">
              Done
            </button>
          }
        >
          <div className="p-6">
            <textarea
              value={entry.task}
              onChange={e => onUpdate('task', e.target.value)}
              placeholder="What did you work on?"
              rows={12}
              autoFocus
              className="input resize-none"
            />
          </div>
        </SidePanel>
      )}
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

  const [xlsxEnabled, setXlsxEnabled] = useState(false)
  const [uploadMode, setUploadMode]   = useState('inapp')   // 'inapp' | 'excel'
  const [inappResult, setInappResult] = useState(null)

  useEffect(() => {
    supabase.from('app_settings').select('xlsx_upload_enabled').eq('id', 1).single()
      .then(({ data }) => setXlsxEnabled(!!data?.xlsx_upload_enabled))
  }, [])

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
    // functions.invoke() attaches the current session's Authorization
    // header automatically — no manual fetch/headers needed.
    const { data, error } = await supabase.functions.invoke('parse-timesheet', {
      body: { file: base64, fileName: file.name, dryRun: isDryRun },
    })
    if (error) {
      // On a non-2xx response supabase-js returns data: null and puts the
      // raw Response on error.context — the function's own { error } body
      // (the actually useful message) lives there, not on `error` itself.
      let message = error.message
      if (error.context?.json) {
        try { message = (await error.context.json())?.error || message } catch { /* body wasn't JSON */ }
      }
      throw new Error(message)
    }
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
    return <SuccessScreen result={inappResult} onReset={() => setInappResult(null)} navigate={navigate} />
  }

  // ── In-app entry mode (default) ───────────────────────────────
  if (uploadMode === 'inapp') {
    return (
      <InAppEntry
        profile={profile}
        xlsxEnabled={xlsxEnabled}
        onSwitchToExcel={() => setUploadMode('excel')}
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
      <div className="flex items-center gap-3">
        <button onClick={() => setUploadMode('inapp')} className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors">
          <ChevronRight size={18} className="rotate-180" />
        </button>
        <div>
          <h1 className="page-title">Upload Excel timesheet</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Upload your daily or weekly Excel timesheet file.
          </p>
        </div>
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
    </div>
  )
}
