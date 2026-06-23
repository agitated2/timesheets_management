// Pure, dependency-free project-constraint rules.
// This is the single source of truth for the FRONTEND and pre-checks; the
// database triggers/RPCs in schema.sql mirror this logic and are the hard
// guarantee. Keep the two in sync.

export const GRACE_DAYS = 5

function toISO(d) {
  return d.toISOString().slice(0, 10)
}

export function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return toISO(d)
}

export function todayISO(now = new Date()) {
  return toISO(now)
}

/**
 * Effective lifecycle state of a stage.
 * stage: { trackingType:'date'|'hours', allocatedHours, loggedHours, endDate:'YYYY-MM-DD'|null, softClosedAt:ISO|null }
 * Returns 'active' | 'soft_closed' | 'hard_locked'
 */
export function stageEffectiveState(stage, nowISO = todayISO()) {
  const { trackingType, allocatedHours = 0, loggedHours = 0, endDate, softClosedAt } = stage

  if (trackingType === 'hours' && allocatedHours > 0 && loggedHours >= allocatedHours) {
    if (softClosedAt) {
      const graceEnd = addDaysISO(String(softClosedAt).slice(0, 10), GRACE_DAYS)
      if (nowISO > graceEnd) return 'hard_locked'
    }
    return 'soft_closed'
  }

  if (trackingType === 'date' && endDate) {
    if (nowISO > endDate) {
      if (nowISO > addDaysISO(endDate, GRACE_DAYS)) return 'hard_locked'
      return 'soft_closed'
    }
  }

  return 'active'
}

/**
 * Can an entry dated `entryDate` be logged to `stage` right now?
 * Returns { ok, reason, grace } — reason ∈ 'locked' | 'future_on_closed' | null
 */
export function canLogToStage(stage, entryDate, nowISO = todayISO()) {
  const state = stageEffectiveState(stage, nowISO)
  if (state === 'hard_locked') return { ok: false, reason: 'locked', grace: false }
  if (state === 'soft_closed') {
    // Date-tracked: during grace only accept work dated on/before the closure.
    if (stage.trackingType === 'date' && stage.endDate && entryDate > stage.endDate) {
      return { ok: false, reason: 'future_on_closed', grace: true }
    }
    return { ok: true, reason: null, grace: true }
  }
  return { ok: true, reason: null, grace: false }
}

/** Would adding `addHours` to an hour-tracked stage exceed its pool? */
export function isOverBudget(stage, addHours = 0) {
  if (stage.trackingType !== 'hours' || !(stage.allocatedHours > 0)) return false
  return (stage.loggedHours || 0) + addHours > stage.allocatedHours
}

/**
 * Whether a stage should be offered in the selection menu for a given date.
 * Active → always. Soft-closed (date) → only for historical dates within its
 * window. Hard-locked → never.
 */
export function isStageSelectable(stage, entryDate, nowISO = todayISO()) {
  return canLogToStage(stage, entryDate, nowISO).ok
}
