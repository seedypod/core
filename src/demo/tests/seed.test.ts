import { describe, expect, it } from 'vitest'
import { describeRule } from '../../autopilot/describe'
import { RuleInput } from '../../autopilot/schema'
import { catalog } from '../../autopilot/signals'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { seedDemo } from '../seed'

describe('demo seed', () => {
  it('tells a mid-cycle story, including valid Autopilot rules', () => {
    const store = new MemoryStore()
    seedDemo(store, new SimHal({ tickMs: 0 }), new Date('2026-10-31T12:00:00Z'))
    expect(store.grow.current()).not.toBeNull()
    expect(store.captures.list().length).toBe(12)
    const rules = store.automations.list()
    expect(rules.map(r => [r.name, r.dryRun])).toEqual([['Tank getting low', false], ['Dim when hot', false], ['pH drifting up', true]])
    const info = new Map(catalog().map(c => [c.key, c]))
    for (const r of rules) {
      expect(RuleInput.safeParse(r).success).toBe(true)
      expect(describeRule(r, k => info.get(k))).toMatch(/\.$/)
    }
  })
})
