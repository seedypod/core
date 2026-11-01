import { describe, expect, it } from 'vitest'
import { firstComparison, summarize, type BacktestResult } from '../backtest'
import type { Condition } from '../types'

const sig = (signal: string) => ({ kind: 'signal' as const, signal })
const lit = (value: number) => ({ kind: 'literal' as const, value })

describe('firstComparison', () => {
  it('finds the first signal compared with a number, through and/or/not/sustained', () => {
    const c: Condition = { kind: 'sustained', forMin: 10, condition: { kind: 'and', conditions: [{ kind: 'timeBetween', start: '08:00', end: '20:00' }, { kind: 'compare', op: '<', left: { kind: 'window', fn: 'avg', signal: 'sensor.water_level_pct', lastMin: 30 }, right: lit(25) }] } }
    expect(firstComparison(c)).toEqual({ key: 'sensor.water_level_pct', op: '<', threshold: 25 })
    expect(firstComparison({ kind: 'not', condition: { kind: 'compare', op: '>', left: lit(7), right: sig('sensor.ph') } })).toEqual({ key: 'sensor.ph', op: '<', threshold: 7 })
    expect(firstComparison({ kind: 'between', subject: sig('sensor.ec'), min: lit(1), max: lit(2) })).toEqual({ key: 'sensor.ec', op: '<=', threshold: 2 })
    expect(firstComparison({ kind: 'or', conditions: [{ kind: 'onDays', days: ['monday'] }] })).toBeNull()
    expect(firstComparison({ kind: 'compare', op: '>', left: sig('a'), right: sig('b') })).toBeNull()
  })
})

describe('summarize', () => {
  const times = Array.from({ length: 96 }, (_, i) => new Date(Date.UTC(2026, 9, 30) + i * 15 * 60_000).toISOString())
  const result: BacktestResult = {
    from: '2026-10-30T00:00:00.000Z',
    to: '2026-10-31T00:00:00.000Z',
    stepMin: 15,
    times,
    traces: [{ key: 'sensor.water_level_pct', label: 'tank level', unit: '%', values: times.map((_, i) => (i < 10 ? null : 80 - i * 0.5)) }],
    liveOnly: [],
    fires: [{ at: times[90] as string, outcome: 'fired', actions: [] }, { at: times[95] as string, outcome: 'dry_run', actions: [] }],
    suppressed: [{ at: times[93] as string, reason: 'cooldown' }],
    summary: { fires: 2, suppressed: 1, unknownSteps: 10, disabledAt: null },
  }
  const rule = { conditions: { kind: 'compare', op: '<', left: sig('sensor.water_level_pct'), right: lit(40) } as Condition }

  it('boils the replay down to counts, the low point against the threshold, and a sparkline with fire marks', () => {
    const s = summarize(result, rule, 24)
    expect(s).toMatchObject({ days: 1, wouldFire: 2, suppressed: 1, disabledAt: null, watch: { key: 'sensor.water_level_pct', label: 'tank level', unit: '%', op: '<', threshold: 40, extreme: 32.5 } })
    expect(s.spark).toHaveLength(24)
    expect(s.spark.slice(0, 2)).toEqual([null, null])
    expect(s.spark[23]).toBeCloseTo(80 - 93.5 * 0.5)
    expect(s.fireAt).toEqual([22, 23])
  })

  it('has no watch when the rule compares nothing with a number', () => {
    const s = summarize(result, { conditions: { kind: 'timeBetween', start: '08:00', end: '09:00' } })
    expect(s.watch).toBeNull()
    expect(s.spark).toEqual([])
  })
})
