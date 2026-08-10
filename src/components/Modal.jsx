import { X } from 'lucide-react'
import clsx from 'clsx'

/**
 * Shared modal shell: fixed-position backdrop, capped at 90% of viewport
 * height so content taller than the screen scrolls inside the body instead
 * of pushing buttons off-screen, with the header pinned.
 */
export default function Modal({ title, icon, onClose, children, wide = false }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className={clsx('bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full flex flex-col max-h-[90vh]', wide ? 'max-w-lg' : 'max-w-md')}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="font-semibold text-sm">{title}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}
