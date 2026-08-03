import { describe, it, expect } from 'vitest'
import { canLogToStage, isStageSelectable } from './projectRules'

describe('canLogToStage', () => {
  const stage = { startDate: '2026-06-01', endDate: '2026-06-30' }

  it('accepts an entry inside the window', () => {
    expect(canLogToStage(stage, '2026-06-15')).toEqual({ ok: true, reason: null })
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
  it('has no upper bound when end date is unset', () => {
    expect(canLogToStage({ startDate: '2026-01-01', endDate: null }, '2030-01-01').ok).toBe(true)
  })
  it('has no lower bound when start date is unset', () => {
    expect(canLogToStage({ startDate: null, endDate: '2026-12-31' }, '2000-01-01').ok).toBe(true)
  })
})

describe('isStageSelectable', () => {
  const s = { startDate: '2026-06-01', endDate: '2026-06-30' }

  it('hides a stage for dates outside its window', () => {
    expect(isStageSelectable(s, '2026-05-01')).toBe(false) // not opened
    expect(isStageSelectable(s, '2026-06-15')).toBe(true)
    expect(isStageSelectable(s, '2026-07-15')).toBe(false) // ended
  })
})
