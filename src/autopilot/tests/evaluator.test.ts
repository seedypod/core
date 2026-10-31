import { describe, expect, it } from 'vitest'
import { maxWindowMin, signalsOf, windowedSignals } from '../ast'
import { evaluateCondition, inTimeWindow } from '../evaluator'
import { evaluateExpr, SustainTracker, type EvalContext } from '../expressions'
import { RuleInput } from '../schema'
import type { Condition, Expr } from '../types'
import { WindowStore } from '../windows'

const lit = (value: number): Expr => ({ kind: 'literal', value })
const sig = (signal: string): Expr => ({ kind: 'signal', signal })

function ctx(values: Record<string, number>, o: Partial<EvalContext> = {}): EvalContext {
  return { signal: k => values[k], windows: new WindowStore(), nowMs: 0, nowMinutes: 12 * 60, dayOfWeek: 'monday', dateKey: '2026-10-31', sustain: new SustainTracker(), ...o }
}

describe('expressions', () => {
  it('evaluates arithmetic, clamps and propagates unknown', () => {
    const c = ctx({ 'sensor.ph': 6.8 })
    expect(evaluateExpr({ kind: 'binary', op: '-', left: sig('sensor.ph'), right: lit(0.3) }, c)).toBeCloseTo(6.5)
    expect(evaluateExpr({ kind: 'binary', op: '*', left: lit(2), right: lit(3) }, c)).toBe(6)
    expect(evaluateExpr({ kind: 'binary', op: '/', left: lit(1), right: lit(0) }, c)).toBeUndefined()
    expect(evaluateExpr({ kind: 'binary', op: '+', left: sig('sensor.ec'), right: lit(1) }, c)).toBeUndefined()
    expect(evaluateExpr({ kind: 'clamp', value: lit(140), min: lit(0), max: lit(100) }, c)).toBe(100)
    expect(evaluateExpr({ kind: 'clamp', value: sig('nope.x'), min: lit(0), max: lit(1) }, c)).toBeUndefined()
  })

  it('aggregates windows over the trailing minutes', () => {
    const w = new WindowStore()
    for (let m = 0; m < 90; m++) w.record('sensor.ph', 6 + m / 100, m * 60_000)
    const now = 89 * 60_000
    expect(w.aggregate('avg', 'sensor.ph', 10, now)).toBeCloseTo(6.845)
    expect(w.aggregate('max', 'sensor.ph', 60, now)).toBeCloseTo(6.89)
    expect(w.aggregate('min', 'sensor.ph', 60, now)).toBeCloseTo(6.29)
    expect(w.aggregate('count', 'sensor.ph', 5, now)).toBe(6)
    expect(w.aggregate('sum', 'sensor.ph', 0, now)).toBeCloseTo(6.89)
    expect(w.aggregate('avg', 'sensor.ec', 10, now)).toBeUndefined()
    expect(w.aggregate('count', 'sensor.ec', 10, now)).toBe(0)
    w.prune(now, 30)
    expect(w.aggregate('count', 'sensor.ph', 120, now)).toBe(31)
    w.prune(now + 3_600_000, 1)
    expect(w.aggregate('avg', 'sensor.ph', 120, now)).toBeUndefined()
    expect(evaluateExpr({ kind: 'window', fn: 'avg', signal: 'sensor.ph', lastMin: 10 }, ctx({}, { windows: w }))).toBeUndefined()
  })
})

describe('conditions', () => {
  const gt = (signal: string, v: number): Condition => ({ kind: 'compare', op: '>', left: sig(signal), right: lit(v) })

  it('uses three-valued AND / OR / NOT', () => {
    const c = ctx({ 'sensor.ph': 7 })
    expect(evaluateCondition({ kind: 'and', conditions: [gt('sensor.ph', 6), gt('sensor.ec', 1)] }, c)).toBeUndefined()
    expect(evaluateCondition({ kind: 'and', conditions: [gt('sensor.ph', 8), gt('sensor.ec', 1)] }, c)).toBe(false)
    expect(evaluateCondition({ kind: 'or', conditions: [gt('sensor.ph', 6), gt('sensor.ec', 1)] }, c)).toBe(true)
    expect(evaluateCondition({ kind: 'or', conditions: [gt('sensor.ph', 8), gt('sensor.ec', 1)] }, c)).toBeUndefined()
    expect(evaluateCondition({ kind: 'or', conditions: [gt('sensor.ph', 8)] }, c)).toBe(false)
    expect(evaluateCondition({ kind: 'not', condition: gt('sensor.ec', 1) }, c)).toBeUndefined()
    expect(evaluateCondition({ kind: 'not', condition: gt('sensor.ph', 8) }, c)).toBe(true)
    expect(evaluateCondition({ kind: 'and', conditions: [] }, c)).toBe(true)
    for (const op of ['>=', '<', '<=', '==', '!='] as const) {
      expect(evaluateCondition({ kind: 'compare', op, left: lit(7), right: lit(7) }, c)).toBe(op === '>=' || op === '<=' || op === '==')
    }
  })

  it('handles between, time windows that wrap midnight, and days', () => {
    const c = ctx({ 'sensor.ph': 6 }, { nowMinutes: 23 * 60 + 30, dayOfWeek: 'saturday' })
    expect(evaluateCondition({ kind: 'between', subject: sig('sensor.ph'), min: lit(5.5), max: lit(6.5) }, c)).toBe(true)
    expect(evaluateCondition({ kind: 'between', subject: sig('sensor.ec'), min: lit(0), max: lit(1) }, c)).toBeUndefined()
    expect(evaluateCondition({ kind: 'timeBetween', start: '23:00', end: '06:00' }, c)).toBe(true)
    expect(evaluateCondition({ kind: 'timeBetween', start: '06:00', end: '23:00' }, c)).toBe(false)
    expect(inTimeWindow(300, '23:00', '06:00')).toBe(true)
    expect(inTimeWindow(600, '08:00', '08:00')).toBe(false)
    expect(evaluateCondition({ kind: 'onDays', days: ['saturday', 'sunday'] }, c)).toBe(true)
  })

  it('sustained holds only after an unbroken streak, and resets on false or unknown', () => {
    const values: Record<string, number> = { 'sensor.ph': 7 }
    const sustain = new SustainTracker()
    const cond: Condition = { kind: 'sustained', condition: gt('sensor.ph', 6.5), forMin: 30 }
    const at = (min: number) => evaluateCondition(cond, ctx(values, { nowMs: min * 60_000, sustain }), 'r1:c')
    expect(at(0)).toBe(false)
    expect(at(20)).toBe(false)
    expect(at(30)).toBe(true)
    values['sensor.ph'] = 6
    expect(at(31)).toBe(false)
    values['sensor.ph'] = 7
    expect(at(32)).toBe(false)
    delete values['sensor.ph']
    expect(at(70)).toBeUndefined()
    values['sensor.ph'] = 7
    expect(at(71)).toBe(false)
    sustain.reset('r1:')
    expect(at(101)).toBe(false)
    expect(at(131)).toBe(true)
  })
})

describe('rule schema and AST walkers', () => {
  const rule = RuleInput.parse({
    name: 'pH drift',
    trigger: { kind: 'signalChange', signal: 'sensor.ph' },
    conditions: { kind: 'sustained', forMin: 60, condition: { kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'sensor.ph', lastMin: 45 }, right: { kind: 'literal', value: 6.5 } } },
    actions: [{ kind: 'dose', doser: 'dose_1', durationS: { kind: 'literal', value: 5 } }, { kind: 'setLight', level: { kind: 'binary', op: '-', left: { kind: 'signal', signal: 'light.level' }, right: { kind: 'window', fn: 'max', signal: 'sensor.air_temp', lastMin: 90 } } }],
  })

  it('defaults new rules to dry-run and validates shapes', () => {
    expect(rule).toMatchObject({ enabled: true, dryRun: true, priority: 50, cooldownMin: null })
    expect(RuleInput.safeParse({ ...rule, trigger: { kind: 'timeOfDay', at: '25:00' } }).success).toBe(false)
    expect(RuleInput.safeParse({ ...rule, actions: [] }).success).toBe(false)
    expect(RuleInput.safeParse({ ...rule, trigger: { kind: 'signalChange', signal: 'ph' } }).success).toBe(false)
    expect(RuleInput.safeParse({ ...rule, actions: [{ kind: 'setLight', level: { kind: 'literal', value: 1 }, clamp: { min: 80, max: 20 } }] }).success).toBe(false)
  })

  it('finds every signal, the windowed ones and the longest window', () => {
    expect(signalsOf(rule).sort()).toEqual(['light.level', 'sensor.air_temp', 'sensor.ph'])
    expect([...windowedSignals([rule])].sort()).toEqual(['sensor.air_temp', 'sensor.ph'])
    expect(maxWindowMin([rule])).toBe(90)
    expect(maxWindowMin([])).toBe(10)
  })
})
