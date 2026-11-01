import { describe, expect, it } from 'vitest'
import { describeRule } from '../../autopilot/describe'
import { RuleInput } from '../../autopilot/schema'
import { catalog } from '../../autopilot/signals'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { SqliteStore } from '../../store/sqlite'
import { seedDemo, seedIfFresh } from '../seed'

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

  it('seeds a fresh server database once, and never one that is set up', () => {
    const store = new SqliteStore({ url: ':memory:' })
    const hal = new SimHal({ tickMs: 0 })
    const now = new Date('2026-10-31T12:00:00Z')
    expect(seedIfFresh(store, hal, now)).toBe(true)
    expect(store.settings.get()).toMatchObject({ unitName: 'Kitchen Gardyn', setupComplete: true })
    expect(store.telemetry.range('air_temp', '2026-10-24T00:00:00Z', now.toISOString(), 10_000).length).toBeGreaterThan(600)
    expect(store.pods.list().filter(p => p.plant)).toHaveLength(24)
    expect(seedIfFresh(store, hal, now)).toBe(false)
    expect(store.automations.list()).toHaveLength(3)
    store.close()

    const setUp = new MemoryStore()
    setUp.settings.update({ setupComplete: true })
    expect(seedIfFresh(setUp, hal, now)).toBe(false)
    expect(setUp.grow.current()).toBeNull()
  })
})
