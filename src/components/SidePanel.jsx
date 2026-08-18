import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Right-hand drawer. Same header/backdrop shape as Modal.jsx, but slides in
 * from the edge and pins an optional footer below a scrolling body.
 *
 * Unlike Modal, this closes on Escape and hands focus back to whatever
 * opened it — a drawer that covers the page with no keyboard way out is a
 * trap, and the trigger is usually mid-form.
 */
export default function SidePanel({ title, icon, subtitle, onClose, children, footer }) {
  const openerRef = useRef(null)

  useEffect(() => {
    openerRef.current = document.activeElement
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Focus is on an element inside a panel that is unmounting; without
      // this it falls back to <body> and tab order restarts from the top.
      openerRef.current?.focus?.()
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="fixed right-0 top-0 h-full w-full max-w-md bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 shadow-xl flex flex-col animate-slide-in-right"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0 gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <div className="min-w-0">
              <h3 className="font-semibold text-sm">{title}</h3>
              {subtitle && <p className="text-xs text-gray-400 mt-0.5 truncate">{subtitle}</p>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
