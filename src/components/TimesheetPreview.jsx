import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'

// Wall-clock "HH:MM[:SS]" → "h:mm AM/PM". Deliberately string-based, not a
// Date object — these are TIME-typed values with no date or timezone
// attached, so parsing into a Date and formatting back out would risk
// DST/timezone drift for no reason.
function formatTime12h(t) {
  if (!t) return null
  const [h, m] = t.split(':')
  const hour = Number(h)
  const period = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${m} ${period}`
}

function TimeWindow({ entry: e }) {
  return <>{formatTime12h(e.time_from) ?? '—'} – {formatTime12h(e.time_to) ?? '—'}</>
}

// One entry, collapsed to its key facts (project, stage, hours) with the
// rest — time window, discipline, task — behind a click. Used on the
// review screen so a long task description doesn't push every other entry
// down the page.
function AccordionEntry({ entry: e, nested }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'w-full flex items-center gap-3 py-3.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors',
          nested ? 'pl-9 pr-5' : 'px-5',
        )}
      >
        {open
          ? <ChevronDown size={15} className="flex-shrink-0 text-gray-400" />
          : <ChevronRight size={15} className="flex-shrink-0 text-gray-400" />}
        <span className="font-medium flex-1 min-w-0 truncate">{e.project_name || '—'}</span>
        <span className="text-gray-500 flex-1 min-w-0 truncate">{e.stage_name || '—'}</span>
        <span className="font-semibold text-blue-600 dark:text-blue-400 flex-shrink-0">
          {e.hours_decimal != null ? `${e.hours_decimal}h` : '—'}
        </span>
      </button>
      {open && (
        <div className={clsx('pb-4 animate-slide-down', nested ? 'pl-9 pr-5' : 'px-5')}>
          {/* Left rule drops from the toggle above, so the expanded block
              reads as belonging to that row rather than a new sibling. */}
          <div className={clsx('pl-4 border-l-2 border-gray-200 dark:border-gray-700 space-y-3 text-sm', nested ? 'ml-9' : 'ml-[27px]')}>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-gray-400 mb-0.5">Time window</p>
              <p className="font-mono text-gray-600 dark:text-gray-300"><TimeWindow entry={e} /></p>
            </div>
            <div>
              <p className="text-gray-400 mb-0.5">Discipline</p>
              <p className="text-gray-600 dark:text-gray-300">{e.discipline_name || '—'}</p>
            </div>
          </div>
          <div>
            <p className="text-gray-400 text-xs mb-0.5">Task</p>
            <p className="text-gray-600 dark:text-gray-300 whitespace-pre-line break-words">{e.task || '—'}</p>
          </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Read-only entries list shared by the manager review screen and the
// employee's "Preview & Submit" step, so what an employee previews before
// submitting is exactly what their manager will see.
//
// `collapsible` renders each entry as an accordion (see AccordionEntry)
// instead of one flat row — opt-in, and only used on the review screen.
// The pre-submit preview keeps every field visible at a glance by design:
// the whole point of that screen is a last look before submitting, so
// collapsing entries there would hide the exact mistakes it exists to catch.
//
// `nested` additionally indents each entry (both collapsed and expanded)
// to signal it's a child of whatever row the caller already has it inside
// — HR's per-day/per-project row, for instance. Only meaningful alongside
// `collapsible`; leave it off when this list is a card's only content
// (the review screen) since there's no parent row for the indent to relate to.
//
// entries: [{ time_from, time_to, hours_decimal, project_name, stage_name,
//              discipline_name, task }]
export default function TimesheetPreview({ entries, emptyLabel = 'No entries', showTotal = true, collapsible = false, nested = false }) {
  const total = entries.reduce((s, e) => s + (Number(e.hours_decimal) || 0), 0)

  if (entries.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-8">{emptyLabel}</p>
  }

  return (
    <>
      {collapsible ? (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {entries.map((e, i) => <AccordionEntry key={i} entry={e} nested={nested} />)}
        </div>
      ) : (
        <>
          <div className="hidden sm:grid grid-cols-6 gap-3 px-5 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
            <span>Time window</span>
            <span>Hours</span>
            <span>Project</span>
            <span>Stage</span>
            <span>Discipline</span>
            <span>Task</span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {entries.map((e, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-6 gap-2 px-5 py-3.5 text-sm">
                <span className="font-mono text-xs text-gray-500"><TimeWindow entry={e} /></span>
                <span className="font-semibold text-blue-600 dark:text-blue-400">{e.hours_decimal != null ? `${e.hours_decimal}h` : '—'}</span>
                <span className="font-medium">{e.project_name || '—'}</span>
                <span className="text-gray-500">{e.stage_name || '—'}</span>
                <span className="text-gray-500">{e.discipline_name || '—'}</span>
                <span className="text-gray-400 whitespace-pre-line break-words">{e.task || '—'}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {showTotal && (
        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800 flex justify-end">
          <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
            Total: {total.toFixed(2)}h
          </span>
        </div>
      )}
    </>
  )
}
