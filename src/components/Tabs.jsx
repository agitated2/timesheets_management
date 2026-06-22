import clsx from 'clsx'

/**
 * Shared underline tab bar (the HR-Panel style), brand-accent active state.
 * tabs: [{ key, label, icon? , badge? }]
 */
export default function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-800 -mb-px">
      {tabs.map(t => {
        const Icon = t.icon
        const on = active === t.key
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={clsx(
              'flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors',
              on
                ? 'border-ae7-red text-ae7-red'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
            )}
          >
            {Icon && <Icon size={15} />}
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full">{t.badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
