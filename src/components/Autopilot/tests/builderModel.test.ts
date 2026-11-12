import { describe, expect, it } from 'vitest'
import { describeRule } from '@/src/autopilot/describe'
import { RuleInput } from '@/src/autopilot/schema'
import { catalog } from '@/src/autopilot/signals'
import { defaultAction, emptyDraft, fromRule, problems, toRule, type Draft } from '../builderModel'

const info = new Map(catalog().map(c => [c.key, c]))
const labels = (k: string) => info.get(k)

describe('builder model', () => {
  it('round-trips every shape the form can make, and the result validates', () => {
    const drafts: Draft[] = [
      emptyDraft(),
      { ...emptyDraft(), name: 'hot', join: 'or', rows: [{ signal: 'sensor.air_temp', agg: 'avg', windowMin: 20, op: '>=', value: 30 }, { signal: 'sensor.humidity', agg: 'max', windowMin: 10, op: '<', value: 40 }], time: { start: '10:00', end: '18:00' }, sustainMin: 15, actions: [{ kind: 'setLight', level: 60, holdMinutes: null }, { kind: 'setLight', level: 20, holdMinutes: 45 }] },
      { ...emptyDraft(), name: 'all', trigger: { kind: 'timeOfDay', at: '07:30', days: ['monday'] }, rows: [], actions: (['notify', 'runPump', 'stopPump', 'dose', 'setPodStatus'] as const).map(defaultAction).map(a => (a.kind === 'notify' ? { ...a, message: 'hi' } : a)) },
    ]
    for (const d of drafts) {
      const rule = toRule({ ...d, name: d.name || 'x' })
      expect(RuleInput.safeParse(rule).success).toBe(true)
      expect(fromRule(rule)).toEqual({ ...d, name: d.name || 'x' })
    }
  })

  it('refuses to show rules the form can\'t represent', () => {
    const base = toRule({ ...emptyDraft(), name: 'x' })
    expect(fromRule({ ...base, conditions: { kind: 'not', condition: base.conditions } })).toBeNull()
    expect(fromRule({ ...base, conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: { kind: 'signal', signal: 'sensor.ph' }, right: { kind: 'signal', signal: 'sensor.ec' } }] } })).toBeNull()
    expect(fromRule({ ...base, actions: [{ kind: 'setLight', level: { kind: 'literal', value: 3 }, clamp: { min: 0, max: 50 } }] })).toBeNull()
    expect(fromRule({ ...base, actions: [{ kind: 'runPump', durationS: { kind: 'signal', signal: 'sensor.ph' } }] })).toBeNull()
    expect(fromRule({ ...base, conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: { kind: 'window', fn: 'sum', signal: 'sensor.ph', lastMin: 5 }, right: { kind: 'literal', value: 1 } }] } })).toBeNull()
  })

  it('lists what is missing before saving', () => {
    expect(problems({ ...emptyDraft(), name: '' })).toEqual(['Give the rule a name.'])
    expect(problems({ ...emptyDraft(), name: 'x', actions: [] })).toEqual(['Add at least one action.'])
    expect(problems({ ...emptyDraft(), name: 'x', actions: [{ kind: 'notify', message: ' ' }], rows: [{ signal: 'sensor.ph', agg: 'now', windowMin: 1, op: '>', value: Number.NaN }] })).toEqual(['A notification needs a message.', 'Every comparison needs a number.'])
  })

  it('reads as a sentence', () => {
    const d: Draft = { ...emptyDraft(), name: 'x', sustainMin: 30, time: { start: '22:00', end: '06:00' }, cooldownMin: 60, actions: [{ kind: 'dose', doser: 'dose_1', durationS: 5 }, { kind: 'setLight', level: 40, holdMinutes: 90 }] }
    expect(describeRule(toRule(d), labels)).toBe('Every 5 minutes, if pH is above 6.5 for 30 min and it\'s between 22:00 and 06:00, run doser 1 for 5 s, then set the light to 40%, holding 90 min. At most once every 60 min.')
    const hot = toRule({ ...emptyDraft(), name: 'x', trigger: { kind: 'signalChange', signal: 'sensor.air_temp' }, rows: [{ signal: 'sensor.air_temp', agg: 'avg', windowMin: 15, op: '>=', value: 30 }], cooldownMin: null, actions: [{ kind: 'notify', message: 'hot' }, { kind: 'setPodStatus', slot: 7, status: 'attention' }, { kind: 'stopPump' }, { kind: 'runPump', durationS: 20 }] })
    expect(describeRule(hot, labels)).toBe('When air temperature changes, if the average air temperature over 15 min is at least 30°C, notify “hot”, then mark pod 7 as attention, then stop the pump, then run the pump for 20 s.')
    expect(describeRule({ ...toRule({ ...emptyDraft(), name: 'x', rows: [], cooldownMin: null }), trigger: { kind: 'timeOfDay', at: '07:00', days: ['saturday', 'sunday'] } }, labels)).toBe('At 07:00 on Sat, Sun, notify “pH is high”.')
  })
})
