import { describe, expect, it } from 'vitest'
import { describeAction, describeCondition, describeExpr, describeRule, describeTrigger } from '../describe'
import { catalog } from '../signals'

const info = new Map(catalog().map(c => [c.key, c]))
const labels = (k: string) => info.get(k)
const lit = (value: number) => ({ kind: 'literal' as const, value })
const sig = (signal: string) => ({ kind: 'signal' as const, signal })

describe('describe', () => {
  it('renders every expression kind, keeping acronyms and unknown keys', () => {
    expect(describeExpr({ kind: 'binary', op: '*', left: sig('sensor.air_temp'), right: lit(1.5) }, labels)).toBe('air temperature × 1.5')
    expect(describeExpr({ kind: 'binary', op: '/', left: sig('sensor.ec'), right: lit(2) }, labels)).toBe('EC ÷ 2')
    expect(describeExpr({ kind: 'binary', op: '+', left: lit(0.1234), right: lit(1) }, labels)).toBe('0.123 + 1')
    expect(describeExpr({ kind: 'clamp', value: sig('sensor.ph'), min: lit(5), max: lit(7) }, labels)).toBe('pH (kept within 5–7)')
    expect(describeExpr({ kind: 'window', fn: 'count', signal: 'sensor.ph', lastMin: 10 }, labels)).toBe('the number of readings of pH over 10 min')
    expect(describeExpr(sig('custom.thing'), labels)).toBe('custom.thing')
  })

  it('renders every condition kind with units where they help', () => {
    expect(describeCondition({ kind: 'or', conditions: [{ kind: 'compare', op: '!=', left: sig('alert.water_low'), right: lit(0) }, { kind: 'compare', op: '<=', left: sig('pod.7.green'), right: lit(0.2) }] }, labels)).toBe('alert: water low is not 0 or pod 7 green area is at most 0.2')
    expect(describeCondition({ kind: 'not', condition: { kind: 'onDays', days: ['monday', 'friday'] } }, labels)).toBe('not (it\'s Mon, Fri)')
    expect(describeCondition({ kind: 'between', subject: sig('sensor.water_temp'), min: lit(18), max: lit(24) }, labels)).toBe('water temperature is between 18 and 24 °C')
    expect(describeCondition({ kind: 'compare', op: '==', left: sig('grow.day'), right: lit(14) }, labels)).toBe('grow-cycle day is 14 days')
  })

  it('renders triggers and actions', () => {
    expect(describeTrigger({ kind: 'tick', everyMin: 1 }, labels)).toBe('Every minute')
    expect(describeTrigger({ kind: 'timeOfDay', at: '06:30' }, labels)).toBe('At 06:30')
    expect(describeAction({ kind: 'setLight', level: lit(30), clamp: { min: 10, max: 60 }, mode: 'one-shot' }, labels)).toBe('set the light to 30 % (kept within 10–60 %), holding 60 min')
    expect(describeAction({ kind: 'runPump', durationS: lit(20), level: 25 }, labels)).toBe('run the pump for 20 s at 25 %')
    expect(describeRule({ trigger: { kind: 'tick', everyMin: 1 }, conditions: { kind: 'and', conditions: [] }, actions: [{ kind: 'stopPump' }], cooldownMin: null }, labels)).toBe('Every minute, stop the pump.')
  })
})
