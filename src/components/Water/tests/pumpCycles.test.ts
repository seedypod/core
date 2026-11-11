import { describe, expect, it } from 'vitest'
import { asCycle, belowCutoff, cutoffPct, cycleWhen, fmtCountdown, fmtMinutes, fmtSpan, fmtWhen, levelAt, nextFire, nextRun, runSource, tankTrend, type PumpCycle } from '../pumpCycles'

const cycle = (id: string, minute: number, days = 127, enabled = true): PumpCycle => ({ id, kind: 'pump', name: id, enabled, days, spec: { minute, durationS: 300 } })
// Sunday 1 Nov 2026, 12:00 local.
const now = new Date(2026, 10, 1, 12, 0)

describe('next run', () => {
  it('finds the next firing on one of the cycle’s days', () => {
    expect(nextFire(cycle('m', 480), now)).toEqual(new Date(2026, 10, 2, 8, 0))
    expect(nextFire(cycle('e', 1200), now)).toEqual(new Date(2026, 10, 1, 20, 0))
    expect(nextFire(cycle('fri', 480, 0b0010000), now)).toEqual(new Date(2026, 10, 6, 8, 0))
    expect(nextFire(cycle('never', 480, 0), now)).toBeNull()
  })

  it('finds it on the unit\'s clock, not this machine\'s, across a clock change', () => {
    // 12:00 PDT on Saturday 31 October; Los Angeles falls back at 02:00 on the 1st.
    const sat = new Date('2026-10-31T19:00:00Z')
    expect(nextFire(cycle('m', 480), sat, 'America/Los_Angeles')?.toISOString()).toBe('2026-11-01T16:00:00.000Z')
    // A Sunday-only run (Sun = 64): tomorrow in Los Angeles; in Tokyo it's already 04:00 Sunday, so later today.
    expect(nextFire(cycle('sun', 480, 64), sat, 'America/Los_Angeles')?.toISOString()).toBe('2026-11-01T16:00:00.000Z')
    expect(nextFire(cycle('sun', 480, 64), sat, 'Asia/Tokyo')?.toISOString()).toBe('2026-10-31T23:00:00.000Z')
    // And a Saturday-only one there is next week's.
    expect(nextFire(cycle('sat', 480, 32), sat, 'Asia/Tokyo')?.toISOString()).toBe('2026-11-06T23:00:00.000Z')
    expect(nextRun([cycle('m', 480)], sat, 'UTC')?.at.toISOString()).toBe('2026-11-01T08:00:00.000Z')
    expect(cycleWhen(cycle('m', 480), null, sat, 'UTC')).toBe('next in 13 h')
  })

  it('picks the soonest enabled cycle', () => {
    expect(nextRun([cycle('m', 480), cycle('e', 1200)], now)?.cycle.id).toBe('e')
    expect(nextRun([cycle('m', 480), cycle('e', 1200, 127, false)], now)?.cycle.id).toBe('m')
    expect(nextRun([cycle('e', 1200, 127, false)], now)).toBeNull()
  })

  it('shows whichever of the last and next run is nearer', () => {
    expect(cycleWhen(cycle('m', 480), new Date(2026, 10, 1, 8, 0), now)).toBe('ran 4 h ago')
    expect(cycleWhen(cycle('e', 1200), new Date(2026, 9, 31, 20, 0), now)).toBe('next in 8 h')
    expect(cycleWhen(cycle('e', 1200), null, now)).toBe('next in 8 h')
    expect(cycleWhen(cycle('off', 1200, 127, false), null, now)).toBe('off')
    expect(cycleWhen(cycle('never', 1200, 0), null, now)).toBe('never runs')
  })
})

describe('formatting', () => {
  it('spans, run lengths and run times', () => {
    expect(fmtSpan(20_000)).toBe('1 min')
    expect(fmtSpan(25 * 60_000)).toBe('25 min')
    expect(fmtSpan(30 * 3_600_000)).toBe('30 h')
    expect(fmtSpan(72 * 3_600_000)).toBe('3 d')
    expect(fmtMinutes(300)).toBe('5 min')
    expect(fmtMinutes(90)).toBe('1 min 30 s')
    expect(fmtMinutes(45)).toBe('45 s')
    expect(fmtMinutes(900)).toBe('15 min')
    expect(fmtMinutes(3900)).toBe('1 h 5 min')
    expect(fmtMinutes(7200)).toBe('2 h')
    expect(fmtCountdown(899.2)).toBe('15:00')
    expect(fmtCountdown(5)).toBe('0:05')
    expect(fmtWhen(new Date(2026, 10, 1, 8, 0), now)).toBe('Today 08:00')
    expect(fmtWhen(new Date(2026, 9, 31, 20, 5), now)).toBe('Yesterday 20:05')
    expect(fmtWhen(new Date(2026, 9, 29, 8, 0), now)).toMatch(/29.* 08:00$/)
  })
})

describe('tank', () => {
  it('places the pump cutoff on the calibrated scale', () => {
    expect(cutoffPct(16, 5, 20)).toBe(27)
    expect(cutoffPct(30, 5, 20)).toBe(0)
    expect(cutoffPct(null, 5, 20)).toBeNull()
    expect(cutoffPct(16, 20, 5)).toBeNull()
  })

  it('says the pump won\'t start as the HAL does: the distance at or past waterLowCm, else the unrounded level', () => {
    const cal = { waterLowCm: 16, fullCm: 5, emptyCm: 20 }
    expect(belowCutoff({ ...cal, distance: { value: 16, unit: 'cm' }, levelPct: 99 })).toBe(true)
    expect(belowCutoff({ ...cal, distance: { value: 15.9, unit: 'cm' }, levelPct: 0 })).toBe(false)
    // No distance in cm: 26.8% rounds to the 27% cutoff, but is over the true 26.67%.
    expect(belowCutoff({ ...cal, distance: { value: 6.3, unit: 'in' }, levelPct: 26.8 })).toBe(false)
    expect(belowCutoff({ ...cal, levelPct: 26.6 })).toBe(true)
    expect(belowCutoff({ ...cal })).toBe(false)
    expect(belowCutoff({ waterLowCm: null, fullCm: 5, emptyCm: 20, distance: { value: 19, unit: 'cm' } })).toBe(false)
    expect(belowCutoff({ waterLowCm: 16, fullCm: 20, emptyCm: 5, levelPct: 0 })).toBe(false)
  })

  it('finds top-ups and the daily drain, skipping gaps', () => {
    const day = 86_400_000
    const xs = [0, 0.5, 1, 1.5, 2].map(d => d * day)
    expect(tankTrend(xs, [90, 80, Number.NaN, 70, 95])).toEqual({ topUps: [4], dropPerDay: 10 })
    expect(tankTrend([0], [50])).toEqual({ topUps: [], dropPerDay: null })
  })

  it('reads only pump schedules as cycles', () => {
    expect(asCycle({ id: 'p', kind: 'pump', name: 'P', enabled: true, days: 127, spec: { minute: 0, durationS: 60 } })?.spec.durationS).toBe(60)
    expect(asCycle({ id: 'l', kind: 'light', name: 'L', enabled: true, days: 127, spec: { setpoints: [] } })).toBeNull()
  })
})

describe('levelAt', () => {
  const pts = [{ ts: '2026-11-01T10:00:00Z', value: 80 }, { ts: '2026-11-01T11:00:00Z', value: 70 }]
  it('takes the last sample at or before the moment, else the first after, else none', () => {
    expect(levelAt(pts, '2026-11-01T10:30:00Z')).toBe(80)
    expect(levelAt(pts, '2026-11-01T11:00:00Z')).toBe(70)
    expect(levelAt(pts, '2026-11-01T09:00:00Z')).toBe(80)
    expect(levelAt([], '2026-11-01T09:00:00Z')).toBeNull()
  })
})

describe('runSource', () => {
  const cycles = [{ id: 'morning', name: 'Morning watering' }]
  it('names the cycle that fired within two minutes of the run, else none', () => {
    expect(runSource([{ scheduleId: 'morning', firedAt: '2026-11-01T08:00:00Z' }], cycles, '2026-11-01T08:01:00Z')).toBe('Morning watering')
    expect(runSource([{ scheduleId: 'morning', firedAt: '2026-11-01T08:00:00Z' }], cycles, '2026-11-01T08:05:00Z')).toBeNull()
    expect(runSource([{ scheduleId: 'light', firedAt: '2026-11-01T08:00:00Z' }], cycles, '2026-11-01T08:00:00Z')).toBeNull()
  })
})
