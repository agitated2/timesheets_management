// Pure, dependency-free project-constraint rules.
// This is the single source of truth for the FRONTEND and pre-checks; the
// database triggers/RPCs in schema.sql mirror this logic and are the hard
// guarantee, and netlify/functions/parse-timesheet.js mirrors it for Excel.
// Keep all three in sync.
//
// Enforcement model (hard blocks, no grace period):
//   DATE-tracked stage — an entry dated D is loggable iff start_date ≤ D ≤ end_date.
//     · D < start_date  → 'not_started' (stage hasn't opened; contact line manager)
//     · D > end_date    → 'ended'       (future-dated work blocked; backdating within
//                                        the window stays open indefinitely)
//   HOURS-tracked stage — loggable while the pool has room.
//     · logged ≥ allocated              → 'pool_full' (blocked for every date)
//     · entry would exceed remaining    → not blocked here, surfaced via poolFit so
//                                         the employee can reduce it or request an
//                                         extension (see poolFit).

function round2(n) { return Math.round(n * 100) / 100 }

function toISO(d) {
  return d.toISOString().slice(0, 10)
}

export function todayISO(now = new Date()) {
  return toISO(now)
}

/**
 * Can an entry dated `entryDate` be logged to `stage`?
 * stage: { trackingType:'date'|'hours', startDate, endDate, allocatedHours, loggedHours }
 * Returns { ok, reason, remaining }
 *   reason ∈ 'not_started' | 'ended' | 'pool_full' | null
 *   remaining — hours left in the pool (hours stages only), else null
 */
export function canLogToStage(stage, entryDate) {
  const { trackingType, startDate, endDate, allocatedHours = 0, loggedHours = 0 } = stage

  if (trackingType === 'date') {
    if (startDate && entryDate < startDate) return { ok: false, reason: 'not_started', remaining: null }
    if (endDate   && entryDate > endDate)   return { ok: false, reason: 'ended',       remaining: null }
    return { ok: true, reason: null, remaining: null }
  }

  if (trackingType === 'hours' && allocatedHours > 0) {
    const remaining = round2(allocatedHours - loggedHours)
    if (remaining <= 0) return { ok: false, reason: 'pool_full', remaining: 0 }
    return { ok: true, reason: null, remaining }
  }

  return { ok: true, reason: null, remaining: null }
}

/**
 * How a proposed `addHours` fits an hour-tracked stage's remaining pool.
 * Returns { fits, remaining, overflow }.
 *   overflow > 0 → the entry must be reduced to `remaining` (or an extension requested).
 * Date-tracked / unbounded stages always fit.
 */
export function poolFit(stage, addHours = 0) {
  if (stage.trackingType !== 'hours' || !(stage.allocatedHours > 0)) {
    return { fits: true, remaining: null, overflow: 0 }
  }
  const remaining = round2((stage.allocatedHours || 0) - (stage.loggedHours || 0))
  const overflow  = round2(Math.max(0, addHours - remaining))
  return { fits: overflow <= 0, remaining: Math.max(0, remaining), overflow }
}

/**
 * Whether a stage should be offered in the selection menu for a given entry date.
 * A stage that hasn't opened, has ended (for this date), or whose pool is
 * exhausted is not selectable.
 */
export function isStageSelectable(stage, entryDate) {
  return canLogToStage(stage, entryDate).ok
}
