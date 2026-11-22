import { describe, expect, it } from 'vitest'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { cycleDay, dueReminders, GrowEngine, RETIRED_NUTRIENTS } from '../grow'

describe('grow reminders', () => {
  it('computes due one-shot reminders, and leaves feeding to the Feed chore', () => {
    const store = new MemoryStore()
    const cycle = store.grow.start('2026-01-01T00:00:00Z')
    const s = store.settings.get()
    expect(cycleDay(cycle, new Date('2026-01-15T12:00:00Z'))).toBe(14)
    const due = dueReminders(cycle, s, new Date('2026-01-15T12:00:00Z'))
    expect(due).toEqual([{ kind: 'reminder_thinning', dueDay: 14, detail: 'Thin seedlings: 1 sprout per pod for greens and fruiting plants, 3 for herbs and small flowers' }])
  })

  it('engine issues each reminder once and acknowledge clears it', () => {
    const store = new MemoryStore()
    store.grow.start('2026-01-01T00:00:00Z')
    let now = new Date('2026-01-15T00:00:00Z')
    const engine = new GrowEngine({ store, events: createEventBus(), now: () => now })
    expect(engine.tick().map(r => r.kind)).toEqual(['reminder_thinning'])
    expect(engine.tick()).toEqual([])
    now = new Date('2026-01-22T00:00:00Z')
    expect(engine.tick().map(r => r.kind)).toEqual(['reminder_root_check'])
    expect(store.alerts.list({ activeOnly: true })).toHaveLength(2)
    engine.acknowledge('reminder_thinning')
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind)).not.toContain('reminder_thinning')
  })

  it('words the thinning reminder with each planted pod\'s count', () => {
    const store = new MemoryStore()
    store.grow.start('2026-01-01T00:00:00Z')
    const at = '2026-01-01T00:00:00Z'
    for (const [slot, plant] of [[1, 'Basil'], [2, 'Romaine'], [3, 'Arugula'], [4, 'Kale']] as const) store.pods.update(slot, { plant, status: 'seeded', plantedAt: at }, at)
    new GrowEngine({ store, events: createEventBus(), now: () => new Date('2026-01-15T00:00:00Z') }).tick()
    expect(store.alerts.list({ activeOnly: true }).find(a => a.kind === 'reminder_thinning')?.detail).toBe('Thin seedlings, cutting the extras at the base: pods 2 and 4 to 1 sprout and pod 1 to 3.')
  })

  it('disabled reminders (0 days) never fire', () => {
    const store = new MemoryStore()
    store.settings.update({ thinningReminderDays: 0, rootCheckReminderDays: 0, harvestReminderDays: 0, nutrientReminderDays: 0 })
    store.grow.start('2026-01-01T00:00:00Z')
    const engine = new GrowEngine({ store, events: createEventBus(), now: () => new Date('2027-01-01T00:00:00Z') })
    expect(engine.tick()).toEqual([])
  })

  it('clears a nutrients reminder left open from before the Feed chore took it over, cycle or not', () => {
    const store = new MemoryStore()
    const events = createEventBus()
    const seen: string[] = []
    events.subscribe((e) => {
      if (e.kind === 'mutation') seen.push(e.path)
    })
    store.alerts.raise(RETIRED_NUTRIENTS, 'Add nutrients (every 7 days)', '2026-01-01T00:00:00Z')
    const engine = new GrowEngine({ store, events, now: () => new Date('2026-01-02T00:00:00Z') })
    expect(engine.tick()).toEqual([])
    expect(store.alerts.list({ activeOnly: true })).toEqual([])
    expect(store.alerts.list()[0]).toMatchObject({ kind: 'reminder_nutrients', clearedAt: '2026-01-02T00:00:00.000Z' })
    engine.tick()
    expect(seen).toEqual(['alerts.reminder_nutrients'])
  })
})
