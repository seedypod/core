import { describe, expect, it } from 'vitest'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { cycleDay, dueReminders, GrowEngine } from '../grow'

describe('grow reminders', () => {
  it('computes due one-shot and recurring reminders', () => {
    const store = new MemoryStore()
    const cycle = store.grow.start('2026-01-01T00:00:00Z')
    const s = store.settings.get()
    expect(cycleDay(cycle, new Date('2026-01-15T12:00:00Z'))).toBe(14)
    const due = dueReminders(cycle, s, new Date('2026-01-15T12:00:00Z'))
    expect(due.map(d => d.kind)).toEqual(['reminder_thinning', 'reminder_nutrients'])
    expect(due.find(d => d.kind === 'reminder_nutrients')?.dueDay).toBe(14)
  })

  it('engine issues each reminder once and acknowledge clears it', () => {
    const store = new MemoryStore()
    store.grow.start('2026-01-01T00:00:00Z')
    let now = new Date('2026-01-08T00:00:00Z')
    const engine = new GrowEngine({ store, events: createEventBus(), now: () => now })
    expect(engine.tick().map(r => r.kind)).toEqual(['reminder_nutrients'])
    expect(engine.tick()).toEqual([])
    now = new Date('2026-01-22T00:00:00Z')
    const kinds = engine.tick().map(r => r.kind).sort()
    expect(kinds).toEqual(['reminder_nutrients', 'reminder_root_check', 'reminder_thinning'])
    // one active alert per kind: the nutrients reminder from day 7 is still open
    expect(store.alerts.list({ activeOnly: true })).toHaveLength(3)
    engine.acknowledge('reminder_thinning')
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind)).not.toContain('reminder_thinning')
  })

  it('disabled reminders (0 days) never fire', () => {
    const store = new MemoryStore()
    store.settings.update({ thinningReminderDays: 0, rootCheckReminderDays: 0, harvestReminderDays: 0, nutrientReminderDays: 0 })
    store.grow.start('2026-01-01T00:00:00Z')
    const engine = new GrowEngine({ store, events: createEventBus(), now: () => new Date('2027-01-01T00:00:00Z') })
    expect(engine.tick()).toEqual([])
  })
})
