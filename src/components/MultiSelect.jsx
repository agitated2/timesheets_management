import { useEffect, useRef, useState } from 'react'
import { Search, X, Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'

/**
 * Searchable multi-select with chips and a capped result list.
 *
 * options:  [{ value, label, sublabel? }]
 * value:    array of selected values
 * onChange: (nextValues) => void
 * limit:    max options shown in the dropdown at once (default 10)
 */
export default function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  limit = 10,
  emptyText = 'No matches',
}) {
  const [open, setOpen]     = useState(false)
  const [search, setSearch] = useState('')
  const wrapRef = useRef(null)

  useEffect(() => {
    function onDoc(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const selectedSet = new Set(value)
  const q = search.trim().toLowerCase()
  const matches = options.filter(o =>
    !q || o.label.toLowerCase().includes(q) || (o.sublabel || '').toLowerCase().includes(q)
  )
  const shown = matches.slice(0, limit)

  function toggle(v) {
    onChange(selectedSet.has(v) ? value.filter(x => x !== v) : [...value, v])
  }

  const selectedOptions = options.filter(o => selectedSet.has(o.value))

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="input flex items-center justify-between gap-2 text-left min-h-[38px]"
      >
        <span className="flex flex-wrap gap-1 items-center min-w-0">
          {selectedOptions.length === 0 ? (
            <span className="text-gray-400 text-sm">{placeholder}</span>
          ) : (
            selectedOptions.map(o => (
              <span
                key={o.value}
                onClick={e => { e.stopPropagation(); toggle(o.value) }}
                className="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 text-xs px-2 py-0.5 rounded-md max-w-[160px]"
              >
                <span className="truncate">{o.label}</span>
                <X size={11} className="text-gray-400 hover:text-red-500 flex-shrink-0" />
              </span>
            ))
          )}
        </span>
        <ChevronDown size={15} className="text-gray-400 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl">
          <div className="relative p-2 border-b border-gray-100 dark:border-gray-800">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full pl-8 pr-2 py-1.5 text-sm bg-transparent outline-none"
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {shown.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">{emptyText}</p>
            ) : (
              shown.map(o => {
                const sel = selectedSet.has(o.value)
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    <span className={clsx(
                      'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
                      sel ? 'bg-ae7-red border-ae7-red' : 'border-gray-300 dark:border-gray-600'
                    )}>
                      {sel && <Check size={11} className="text-white" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{o.label}</span>
                      {o.sublabel && <span className="block text-xs text-gray-400 truncate">{o.sublabel}</span>}
                    </span>
                  </button>
                )
              })
            )}
            {matches.length > limit && (
              <p className="text-xs text-gray-400 text-center py-2 border-t border-gray-100 dark:border-gray-800">
                Showing {limit} of {matches.length} — keep typing to narrow
              </p>
            )}
          </div>
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-xs text-gray-500 hover:text-red-500 py-2 border-t border-gray-100 dark:border-gray-800"
            >
              Clear all ({value.length})
            </button>
          )}
        </div>
      )}
    </div>
  )
}
