// Pure, dependency-free project-constraint rules.
// This is the single source of truth for the FRONTEND and pre-checks; the
// database triggers/RPCs in schema.sql mirror this logic and are the hard
// guarantee, and supabase/functions/parse-timesheet/index.ts mirrors it for
// Excel. Keep all three in sync.
//
// Enforcement model (hard blocks, no grace period). Every stage is date-tracked:
//   An entry dated D is loggable iff start_date ≤ D ≤ end_date.
//     · D < start_date  → 'not_started' (stage hasn't opened; contact line manager)
//     · D > end_date    → 'ended'       (future-dated work blocked; backdating within
//                                        the window stays open indefinitely, unless
//                                        the stage is extended)

function toISO(d) {
  return d.toISOString().slice(0, 10)
}

export function todayISO(now = new Date()) {
  return toISO(now)
}

/**
 * Can an entry dated `entryDate` be logged to `stage`?
 * stage: { startDate, endDate }
 * Returns { ok, reason }
 *   reason ∈ 'not_started' | 'ended' | null
 */
export function canLogToStage(stage, entryDate) {
  const { startDate, endDate } = stage
  if (startDate && entryDate < startDate) return { ok: false, reason: 'not_started' }
  if (endDate   && entryDate > endDate)   return { ok: false, reason: 'ended' }
  return { ok: true, reason: null }
}

/**
 * Whether a stage should be offered in the selection menu for a given entry date.
 * A stage that hasn't opened or has ended (for this date) is not selectable.
 */
export function isStageSelectable(stage, entryDate) {
  return canLogToStage(stage, entryDate).ok
}
