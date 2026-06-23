import { describe, it, expect } from 'vitest'
import {
  stageEffectiveState, canLogToStage, isOverBudget, isStageSelectable, addDaysISO,
} from './projectRules'

const NOW = '2026-06-23'

describe('stageEffectiveState — date tracked', () => {
  const base = { trackingType: 'date', endDate: null }

  it('is active with no end date', () => {
    expect(stageEffectiveState({ ...base }, NOW)).toBe('active')
  })
  it('is active before the end date', () => {
    expect(stageEffectiveState({ ...base, endDate: '2026-07-01' }, NOW)).toBe('active')
  })
  it('soft-closes the day after the end date', () => {
    expect(stageEffectiveState({ ...base, endDate: '2026-06-22' }, NOW)).toBe('soft_closed')
  })
  it('stays soft-closed through the 5-day grace window', () => {
    expect(stageEffectiveState({ ...base, endDate: '2026-06-18' }, NOW)).toBe('soft_closed') // 5 days prior
  })
  it('hard-locks once grace passes (> 5 days)', () => {
    expect(stageEffectiveState({ ...base, endDate: '2026-06-17' }, NOW)).toBe('hard_locked') // 6 days prior
  })
})

describe('stageEffectiveState — hour tracked', () => {
  const base = { trackingType: 'hours', allocatedHours: 100 }

  it('is active below the pool', () => {
    expect(stageEffectiveState({ ...base, loggedHours: 80 }, NOW)).toBe('active')
  })
  it('soft-closes when the pool is met', () => {
    expect(stageEffectiveState({ ...base, loggedHours: 100, softClosedAt: '2026-06-22' }, NOW)).toBe('soft_closed')
  })
  it('hard-locks once grace passes after closure', () => {
    expect(stageEffectiveState({ ...base, loggedHours: 120, softClosedAt: '2026-06-10' }, NOW)).toBe('hard_locked')
  })
})

describe('canLogToStage — 5-day retroactive rule (date tracked)', () => {
  // Stage ended 2026-06-22, NOW is 2026-06-23 → soft-closed (grace day 1)
  const stage = { trackingType: 'date', endDate: '2026-06-22' }

  it('accepts a historical entry within the stage window during grace', () => {
    expect(canLogToStage(stage, '2026-06-20', NOW)).toEqual({ ok: true, reason: null, grace: true })
  })
  it('accepts an entry dated exactly on the closure date', () => {
    expect(canLogToStage(stage, '2026-06-22', NOW).ok).toBe(true)
  })
  it('rejects a future-dated entry on a soft-closed stage', () => {
    const r = canLogToStage(stage, '2026-06-23', NOW)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('future_on_closed')
  })
  it('rejects everything once hard-locked (past grace)', () => {
    const locked = { trackingType: 'date', endDate: '2026-06-10' } // > 5 days before NOW
    expect(canLogToStage(locked, '2026-06-09', NOW).ok).toBe(false)
    expect(canLogToStage(locked, '2026-06-09', NOW).reason).toBe('locked')
  })
  it('accepts freely while active', () => {
    const active = { trackingType: 'date', endDate: '2026-07-01' }
    expect(canLogToStage(active, '2026-06-23', NOW).ok).toBe(true)
  })
})

describe('isOverBudget — hour pool overrun', () => {
  const stage = { trackingType: 'hours', allocatedHours: 10, loggedHours: 9 }
  it('flags when an entry pushes past the pool', () => {
    expect(isOverBudget(stage, 4)).toBe(true) // 9 + 4 = 13 > 10
  })
  it('does not flag when it fits', () => {
    expect(isOverBudget(stage, 1)).toBe(false) // 9 + 1 = 10
  })
  it('never flags date-tracked stages', () => {
    expect(isOverBudget({ trackingType: 'date', endDate: '2026-01-01' }, 99)).toBe(false)
  })
})

describe('isStageSelectable', () => {
  it('hides hard-locked stages', () => {
    expect(isStageSelectable({ trackingType: 'date', endDate: '2026-06-01' }, '2026-06-01', NOW)).toBe(false)
  })
  it('offers soft-closed date stages for historical dates only', () => {
    const s = { trackingType: 'date', endDate: '2026-06-22' }
    expect(isStageSelectable(s, '2026-06-21', NOW)).toBe(true)
    expect(isStageSelectable(s, '2026-06-25', NOW)).toBe(false)
  })
})

describe('addDaysISO', () => {
  it('adds calendar days across month boundaries', () => {
    expect(addDaysISO('2026-06-28', 5)).toBe('2026-07-03')
  })
})
