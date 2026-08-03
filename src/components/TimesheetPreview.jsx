// Read-only entries table shared by the manager review screen and the
// employee's "Preview & Submit" step, so what an employee previews before
// submitting is exactly what their manager will see.
//
// entries: [{ time_from, time_to, hours_decimal, project_name, stage_name,
//              discipline_name, task }]
export default function TimesheetPreview({ entries, emptyLabel = 'No entries', showTotal = true }) {
  const total = entries.reduce((s, e) => s + (Number(e.hours_decimal) || 0), 0)

  if (entries.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-8">{emptyLabel}</p>
  }

  return (
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
            <span className="font-mono text-xs text-gray-500">{e.time_from ?? '—'} – {e.time_to ?? '—'}</span>
            <span className="font-semibold text-blue-600 dark:text-blue-400">{e.hours_decimal != null ? `${e.hours_decimal}h` : '—'}</span>
            <span className="font-medium">{e.project_name || '—'}</span>
            <span className="text-gray-500">{e.stage_name || '—'}</span>
            <span className="text-gray-500">{e.discipline_name || '—'}</span>
            <span className="text-gray-400 break-words">{e.task || '—'}</span>
          </div>
        ))}
      </div>
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
