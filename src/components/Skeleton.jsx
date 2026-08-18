import clsx from 'clsx'

/**
 * Base skeleton block. Uses the `.skeleton` class (shimmer + reduced-motion
 * handling live in index.css). Pass a className to size / shape it.
 */
export function Skeleton({ className }) {
  return <div className={clsx('skeleton rounded-md', className)} />
}

/** A few lines of placeholder text; last line is shorter for realism. */
export function SkeletonText({ lines = 3, className }) {
  return (
    <div className={clsx('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={clsx('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

/**
 * List rows matching the app's common "two-line left, pill right" list item
 * (dashboards, history, reviews, notifications, HR lists…).
 */
export function SkeletonList({ rows = 5, className }) {
  return (
    <div className={clsx('divide-y divide-gray-100 dark:divide-gray-800', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-5 py-3.5">
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )
}

/** Grid of stat-card skeletons matching StatCard layout. */
export function SkeletonStats({ count = 4, className }) {
  return (
    <div className={clsx('grid grid-cols-2 lg:grid-cols-4 gap-4', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2 w-full">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-14" />
            </div>
            <Skeleton className="h-4 w-4 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Generic table body skeleton. */
export function SkeletonTable({ rows = 6, cols = 4, className }) {
  return (
    <div className={clsx('divide-y divide-gray-100 dark:divide-gray-800', className)}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={clsx('h-3.5', c === 0 ? 'w-40' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  )
}

export default Skeleton
