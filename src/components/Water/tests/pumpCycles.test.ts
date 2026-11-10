import { describe, expect, it } from 'vitest'
import { asCycle, cutoffPct, cycleWhen, fmtCountdown, fmtMinutes, fmtSpan, fmtWhen, nextFire, nextRun, tankTrend, type PumpCycle } from '../pumpCycles'

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
