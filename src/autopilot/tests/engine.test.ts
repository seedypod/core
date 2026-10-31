import { describe, expect, it } from 'vitest'
import type { LightLease } from '../../control/light'
import { ActionRefused, AutopilotEngine, outcome } from '../engine'
import type { Action, AutomationRule, Condition, RunOutcome } from '../types'

const lit = (value: number) => ({ kind: 'literal' as const, value })
const sig = (signal: string) => ({ kind: 'signal' as const, signal })
const above = (signal: string, v: number): Condition => ({ kind: 'compare', op: '>', left: sig(signal), right: lit(v) })

function rule(o: Partial<AutomationRule> & { actions: Action[] }): AutomationRule {
  return { id: 1, name: 'r', enabled: true, dryRun: false, priority: 50, cooldownMin: null, trigger: { kind: 'tick', everyMin: 1 }, conditions: { kind: 'and', conditions: [] }, ...o }
}

function rig(rules: AutomationRule[], init: Record<string, number> = {}) {
  let now = Date.parse('2026-10-31T12:00:00Z')
  let minutes = 12 * 60
  const values = { ...init }
  const runs: Array<{ id: number, outcome: RunOutcome, detail: Record<string, unknown> }> = []
  const calls: string[] = []
  let leases: LightLease[] = []
  let enabled = true
  let refuse: string | null = null
  const engine = new AutopilotEngine({
    now: () => now,
    clock: () => ({ nowMinutes: minutes, dayOfWeek: 'saturday', dateKey: `2026-10-${31 + Math.floor((now - Date.parse('2026-10-31T00:00:00Z')) / 86_400_000)}` }),
    signals: () => values,
    loadRules: () => rules,
    recordRun: (id, o, detail) => runs.push({ id, outcome: o, detail: detail as Record<string, unknown> }),
    disableRule: (id) => {
      const r = rules.find(x => x.id === id)
      if (r) r.enabled = false
    },
    enabled: () => enabled,
    act: {
      notify: (r, m) => calls.push(`notify:${r.id}:${m}`),
      clearNotice: r => calls.push(`clear:${r.id}`),
      setLightLeases: async (l) => {
        leases = l
      },
      runPump: async (d, level) => {
        if (refuse) throw new ActionRefused(refuse)
        calls.push(`pump:${d}:${level ?? '-'}`)
      },
      stopPump: async () => {
        calls.push('stop')
      },
      dose: async (doser, d) => {
        if (refuse) throw new ActionRefused(refuse)
        calls.push(`${doser}:${d}`)
      },
      setPodStatus: (slot, status) => calls.push(`pod:${slot}:${status}`),
    },
  })
  return {
    engine, values, runs, calls,
    leases: () => leases,
    step: async (min = 1) => {
      now += min * 60_000
      minutes = (minutes + min) % 1440
      await engine.tick()
    },
    setEnabled: (v: boolean) => (enabled = v),
    refuse: (r: string | null) => (refuse = r),
  }
}

describe('AutopilotEngine', () => {
  it('fires on a tick when the condition holds and logs condition-false otherwise', async () => {
    const r = rig([rule({ conditions: above('sensor.ph', 6.5), actions: [{ kind: 'dose', doser: 'dose_1', durationS: lit(5) }] })], { 'sensor.ph': 6.8 })
    await r.engine.tick()
    expect(r.calls).toEqual(['dose_1:5'])
    expect(r.runs[0]).toMatchObject({ outcome: 'fired', detail: { signals: { 'sensor.ph': 6.8 } } })
    r.values['sensor.ph'] = 6.2
    await r.step()
    expect(r.runs[1]).toMatchObject({ outcome: 'skipped', detail: { reason: 'condition-false' } })
    delete r.values['sensor.ph']
    await r.step()
    expect(r.runs[2]).toMatchObject({ outcome: 'skipped', detail: { reason: 'condition-unknown' } })
    expect(r.calls).toEqual(['dose_1:5'])
  })

  it('respects the tick period, cooldown and dry-run', async () => {
    const rules = [rule({ trigger: { kind: 'tick', everyMin: 5 }, cooldownMin: 12, actions: [{ kind: 'runPump', durationS: lit(30.4), level: 20 }] })]
    const r = rig(rules)
    await r.engine.tick()
    for (let i = 0; i < 4; i++) await r.step()
    expect(r.calls).toEqual(['pump:30:20'])
    await r.step()
    expect(r.runs.at(-1)).toMatchObject({ outcome: 'skipped', detail: { reason: 'cooldown' } })
    await r.step(10)
    expect(r.calls).toEqual(['pump:30:20', 'pump:30:20'])
    expect(r.runs.at(-1)).toMatchObject({ outcome: 'clamped' })
    rules[0] = { ...rules[0] as AutomationRule, dryRun: true }
    await r.step(15)
    expect(r.calls).toHaveLength(2)
    expect(r.runs.at(-1)).toMatchObject({ outcome: 'dry_run', detail: { actions: [{ kind: 'runPump', value: 30, dryRun: true }] } })
  })

  it('fires a signalChange trigger on changes only, never on the first sample', async () => {
    const r = rig([rule({ trigger: { kind: 'signalChange', signal: 'sensor.water_level_pct' }, actions: [{ kind: 'notify', message: 'tank moved' }] })], { 'sensor.water_level_pct': 50 })
    await r.engine.tick()
    await r.step()
    expect(r.calls).toEqual([])
    r.values['sensor.water_level_pct'] = 48
    await r.step()
    expect(r.calls).toEqual(['notify:1:tank moved'])
    delete r.values['sensor.water_level_pct']
    await r.step()
    expect(r.calls).toHaveLength(1)
  })

  it('fires a timeOfDay trigger once a day within its grace window', async () => {
    const r = rig([rule({ trigger: { kind: 'timeOfDay', at: '12:05' }, actions: [{ kind: 'stopPump' }] })])
    await r.step(3)
    expect(r.calls).toEqual([])
    await r.step(4)
    await r.step()
    expect(r.calls).toEqual(['stop'])
    // The next day, the first tick inside the window fires again.
    await r.step(24 * 60 - 2)
    expect(r.calls).toEqual(['stop', 'stop'])
    await r.step()
    expect(r.calls).toEqual(['stop', 'stop'])
  })

  it('holds a policy light lease while the condition holds, with anti-thrash, and drops it after', async () => {
    const r = rig([rule({ conditions: above('sensor.air_temp', 30), actions: [{ kind: 'setLight', level: { kind: 'binary', op: '-', left: lit(150), right: { kind: 'binary', op: '*', left: sig('sensor.air_temp'), right: lit(3) } }, clamp: { min: 20, max: 80 } }] })], { 'sensor.air_temp': 31 })
    await r.engine.tick()
    expect(r.leases()).toMatchObject([{ id: 'rule:1:0', level: 57 }])
    r.values['sensor.air_temp'] = 31.3
    await r.step()
    expect(r.leases()[0]?.level).toBe(57)
    expect(r.runs.at(-1)?.detail.actions).toMatchObject([{ antiThrash: true }])
    r.values['sensor.air_temp'] = 45
    await r.step()
    expect(r.leases()[0]?.level).toBe(20)
    expect(r.runs.at(-1)?.outcome).toBe('clamped')
    r.values['sensor.air_temp'] = 25
    await r.step()
    expect(r.leases()).toEqual([])
  })

  it('reacquires a missing policy lease without replaying the rule\'s other actions', async () => {
    const rules = [rule({ trigger: { kind: 'tick', everyMin: 60 }, conditions: above('sensor.air_temp', 30), actions: [{ kind: 'notify', message: 'hot' }, { kind: 'setLight', level: lit(50) }] })]
    const r = rig(rules, { 'sensor.air_temp': 32 })
    await r.engine.tick()
    expect(r.calls).toEqual(['notify:1:hot'])
    r.setEnabled(false)
    await r.step()
    expect(r.leases()).toEqual([])
    r.setEnabled(true)
    await r.step()
    expect(r.leases()).toMatchObject([{ level: 50 }])
    expect(r.calls).toEqual(['notify:1:hot'])
    expect(r.runs.at(-1)?.detail).toMatchObject({ reacquired: true })
  })

  it('gives a one-shot light lease its hold time', async () => {
    const r = rig([rule({ trigger: { kind: 'timeOfDay', at: '12:01' }, actions: [{ kind: 'setLight', level: lit(10), holdMinutes: 5 }] })])
    await r.step()
    expect(r.leases()).toMatchObject([{ level: 10 }])
    await r.step(4)
    expect(r.leases()).toHaveLength(1)
    await r.step(2)
    expect(r.leases()).toEqual([])
  })

  it('disables a runaway rule and records why', async () => {
    const rules = [rule({ actions: [{ kind: 'dose', doser: 'dose_2', durationS: lit(1) }] })]
    const r = rig(rules)
    await r.engine.tick()
    for (let i = 0; i < 13; i++) await r.step()
    expect(r.calls).toHaveLength(12)
    expect(rules[0]?.enabled).toBe(false)
    expect(r.runs.at(-1)).toMatchObject({ outcome: 'error', detail: { reason: 'runaway-disabled' } })
    expect(r.engine.status().rules[0]).toMatchObject({ actionsLastHour: 12 })
  })

  it('logs hald refusals without retrying, and unknown action values as skipped', async () => {
    const r = rig([rule({ actions: [{ kind: 'runPump', durationS: lit(60) }, { kind: 'setLight', level: sig('sensor.missing') }] })])
    r.refuse('dry-run: water below 16 cm')
    await r.engine.tick()
    expect(r.runs[0]).toMatchObject({ outcome: 'refused', detail: { actions: [{ refused: 'dry-run: water below 16 cm' }, { skipped: 'value-unknown' }] } })
  })

  it('stops everything while the kill switch is off', async () => {
    const r = rig([rule({ actions: [{ kind: 'setLight', level: lit(40) }] })])
    await r.engine.tick()
    expect(r.leases()).toHaveLength(1)
    r.setEnabled(false)
    await r.step()
    await r.step()
    expect(r.leases()).toEqual([])
    expect(r.runs).toHaveLength(1)
    expect(r.engine.status().enabled).toBe(false)
  })

  it('clears a rule\'s notice when its condition stops holding and resets state on edits', async () => {
    const rules = [rule({ conditions: above('sensor.ph', 7), cooldownMin: 60, actions: [{ kind: 'notify', message: 'high' }, { kind: 'setPodStatus', slot: 7, status: 'attention' }] })]
    const r = rig(rules, { 'sensor.ph': 7.5 })
    await r.engine.tick()
    expect(r.calls).toEqual(['notify:1:high', 'pod:7:attention'])
    r.values['sensor.ph'] = 6
    await r.step()
    expect(r.calls.at(-1)).toBe('clear:1')
    r.values['sensor.ph'] = 7.5
    await r.step()
    expect(r.runs.at(-1)).toMatchObject({ detail: { reason: 'cooldown' } })
    rules[0] = { ...rules[0] as AutomationRule, conditions: above('sensor.ph', 7.2) }
    await r.step()
    expect(r.runs.at(-1)?.outcome).toBe('fired')
  })

  it('forgets deleted rules and survives a throwing evaluation', async () => {
    const rules = [rule({ actions: [{ kind: 'setLight', level: lit(40) }] })]
    const r = rig(rules)
    await r.engine.tick()
    rules.splice(0, 1, rule({ id: 2, conditions: { kind: 'compare', op: '>', left: lit(1), right: lit(0) }, actions: [{ kind: 'setLight', level: lit(40) }] }))
    await r.step()
    expect(r.leases().map(l => l.id)).toEqual(['rule:2:0'])
    expect(r.engine.status().rules.map(s => s.id)).toEqual([2])
    const bad = rig([rule({ trigger: { kind: 'timeOfDay', at: 'xx' } as never, actions: [{ kind: 'stopPump' }] })])
    bad.engine['triggerActive'] = () => {
      throw new Error('boom')
    }
    await bad.engine.tick()
    expect(bad.runs[0]).toMatchObject({ outcome: 'error', detail: { reason: 'eval-threw', message: 'boom' } })
  })

  it('folds action results into one outcome', () => {
    expect(outcome(false, [{ kind: 'notify' }, { kind: 'runPump', error: 'x' }])).toBe('error')
    expect(outcome(false, [{ kind: 'runPump', refused: 'x' }])).toBe('refused')
    expect(outcome(true, [{ kind: 'runPump', dryRun: true }])).toBe('dry_run')
    expect(outcome(false, [{ kind: 'runPump', skipped: 'value-unknown' }])).toBe('skipped')
    expect(outcome(false, [{ kind: 'setLight', clamped: true, sent: true }])).toBe('clamped')
    expect(outcome(false, [{ kind: 'notify' }])).toBe('fired')
  })
})
