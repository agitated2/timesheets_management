import { describe, it, expect } from 'vitest'
import { canLogToStage, poolFit, isStageSelectable } from './projectRules'

describe('canLogToStage — date tracked', () => {
  const stage = { trackingType: 'date', startDate: '2026-06-01', endDate: '2026-06-30' }

  it('accepts an entry inside the window', () => {
    expect(canLogToStage(stage, '2026-06-15')).toEqual({ ok: true, reason: null, remaining: null })
  })
  it('accepts an entry on the start and end boundaries', () => {
    expect(canLogToStage(stage, '2026-06-01').ok).toBe(true)
    expect(canLogToStage(stage, '2026-06-30').ok).toBe(true)
  })
  it('blocks a date before the stage opens (not_started)', () => {
    const r = canLogToStage(stage, '2026-05-31')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_started')
  })
  it('blocks a future-dated entry past the end (ended)', () => {
    const r = canLogToStage(stage, '2026-07-01')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('ended')
  })
  it('still accepts backdated work within the window long after the end', () => {
    // No grace / hard-lock tail: any date in [start, end] is loggable forever.
    expect(canLogToStage(stage, '2026-06-10').ok).toBe(true)
  })
})

describe('canLogToStage — hour tracked', () => {
  it('accepts while the pool has room', () => {
    const r = canLogToStage({ trackingType: 'hours', allocatedHours: 100, loggedHours: 80 }, '2026-06-15')
    expect(r.ok).toBe(true)
    expect(r.remaining).toBe(20)
  })
  it('blocks once the pool is exhausted, for any date (pool_full)', () => {
    const stage = { trackingType: 'hours', allocatedHours: 100, loggedHours: 100 }
    const r = canLogToStage(stage, '2026-06-15')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('pool_full')
    // Backdating does not bypass an exhausted pool.
    expect(canLogToStage(stage, '2020-01-01').ok).toBe(false)
  })
})

describe('poolFit — remaining-pool partial fill', () => {
  const stage = { trackingType: 'hours', allocatedHours: 10, loggedHours: 5 }

  it('reports overflow when an entry exceeds the remaining pool', () => {
    const fit = poolFit(stage, 9) // 5 left, 9 requested
    expect(fit.fits).toBe(false)
    expect(fit.remaining).toBe(5)
    expect(fit.overflow).toBe(4)
  })
  it('fits when the entry lands exactly on the remaining pool', () => {
    expect(poolFit(stage, 5).fits).toBe(true)
  })
  it('always fits date-tracked stages', () => {
    expect(poolFit({ trackingType: 'date', endDate: '2026-01-01' }, 99).fits).toBe(true)
  })
})

describe('isStageSelectable', () => {
  it('hides a date stage for dates outside its window', () => {
    const s = { trackingType: 'date', startDate: '2026-06-01', endDate: '2026-06-30' }
    expect(isStageSelectable(s, '2026-05-01')).toBe(false) // not opened
    expect(isStageSelectable(s, '2026-06-15')).toBe(true)
    expect(isStageSelectable(s, '2026-07-15')).toBe(false) // ended
  })
  it('hides an hour stage whose pool is exhausted', () => {
    expect(isStageSelectable({ trackingType: 'hours', allocatedHours: 10, loggedHours: 10 }, '2026-06-15')).toBe(false)
    expect(isStageSelectable({ trackingType: 'hours', allocatedHours: 10, loggedHours: 4 }, '2026-06-15')).toBe(true)
  })
})
