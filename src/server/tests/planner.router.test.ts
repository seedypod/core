import { describe, expect, it } from 'vitest'
import { GrowEngine } from '../../grow/grow'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function setup(nowIso = '2026-11-02T12:00:00Z') {
  let now = new Date(nowIso)
  const store = new MemoryStore(30)
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', now: () => now })
  return { store, core, c: createCallerFactory(appRouter)(core.ctx), setNow: (iso: string) => (now = new Date(iso)) }
}

describe('planner router', () => {
  it('serves the catalog with sources and the zone map', async () => {
    const { c } = setup()
    const cat = await c.planner.catalog({ zone: 'low', category: 'herb' })
    expect(cat.plants.map(p => p.id)).toContain('mint')
    expect(cat.sources.zone).toMatch(/help\.mygardyn\.com/)
    expect((await c.planner.zones({ model: 'home' })).counts).toEqual({ high: 12, medium: 12, low: 6 })
    await expect(c.planner.plant({ id: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('layout and bestSpots respect pods already planted', async () => {
    const { c } = setup()
    await c.grow.updatePod({ slot: 8, plant: 'Jalapeño', status: 'growing' })
    const l = await c.planner.layout({ model: 'home', plants: [{ plantId: 'sweet-pepper', count: 2 }], respectExisting: true })
    expect(l.assignments.map(a => a.slot)).not.toContain(8)
    const spots = await c.planner.bestSpots({ model: 'home', plantId: 'basil', limit: 3 })
    expect(spots[0]?.zone).toBe('medium')
  })

  it('save → apply seeds wave-1 pods today and schedules later waves; sow reminders fire on the date', async () => {
    const { c, store, core, setNow } = setup()
    const plan = await c.planner.savePlan({ id: 'p1', name: 'Winter salads', model: 'home', mode: 'staggered', plants: [{ plantId: 'butterhead', count: 2 }, { plantId: 'mint', count: 1 }] })
    expect(plan.layout.assignments).toHaveLength(3)
    expect(plan.sowing.map(w => w.sowOn)).toEqual(['2026-11-02', '2026-11-02', '2026-12-12'])
    const r = await c.planner.applyPlan({ id: 'p1' })
    expect(r.seeded).toHaveLength(2)
    expect(r.scheduled).toEqual([expect.objectContaining({ plantName: 'Butterhead', sowOn: '2026-12-12' })])
    expect(store.pods.list().filter(p => p.status === 'seeded')).toHaveLength(2)
    expect(store.grow.current()?.notes).toBe('Winter salads')

    const engine = new GrowEngine({ store, events: core.ctx.events, now: () => new Date('2026-12-12T09:00:00Z') })
    setNow('2026-12-12T09:00:00Z')
    expect(engine.sowTick()).toEqual(['Butterhead (wave 2)'])
    expect(engine.sowTick()).toEqual([])
    expect(store.alerts.list({ activeOnly: true }).find(a => a.kind === 'reminder_sow')?.detail).toMatch(/Butterhead/)
    await expect(c.planner.applyPlan({ id: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await c.planner.removePlan({ id: 'p1' })).removed).toBe(true)
  })
})
