import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { GrowEngine } from '../../grow/grow'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import type { PlanResult } from '../../plants/planner'
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

  it('explains what did not fit and takes overrides; plans saved before that still list', async () => {
    const { c, store } = setup()
    const plants = [{ plantId: 'jalapeno', count: 13 }, { plantId: 'basil', count: 12 }]
    const l = await c.planner.layout({ model: 'home', plants, respectExisting: true })
    expect(l.zones.map(z => [z.zone, z.free])).toEqual([['high', 0], ['medium', 0], ['low', 6]])
    expect(l.unplaced).toMatchObject([{ plantId: 'jalapeno', code: 'no_space', zones: ['high', 'medium'] }])
    const fix = l.suggestions.find(s => s.kind === 'relocate')?.overrides
    expect(fix?.pins).toHaveLength(2)
    const saved = await c.planner.savePlan({ id: 'p2', name: 'Peppers', model: 'home', mode: 'batch', plants, overrides: fix ?? undefined })
    expect(saved.layout.unplaced).toEqual([])
    expect(saved.layout.overrides).toEqual(fix)

    const legacy = { model: 'home', assignments: [], unplaced: [{ plantId: 'mint', plantName: 'Mint', reason: 'no free slot in the low zone or below' }], free: [] } as unknown as PlanResult
    store.plans.save({ id: 'old', name: 'Old', model: 'home', mode: 'batch', request: [{ plantId: 'mint', count: 1 }], layout: legacy, sowing: [] })
    expect((await c.planner.plans()).find(p => p.id === 'old')?.layout.unplaced[0]?.reason).toMatch(/or below/)
  })

  it('serves the zone map, explanations and overrides over MCP', async () => {
    const { core } = setup()
    const server = createMcpServer(core.ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const body = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((((await client.callTool({ name, arguments: args })).content) as Array<{ text: string }>)[0]?.text ?? 'null') as Record<string, unknown>
    const tools = (await client.listTools()).tools
    expect(tools.find(t => t.name === 'plan_layout')?.description).toMatch(/one zone lower \(never two, never up\)/)
    const zones = await body('planner_zones', { model: 'studio' })
    expect(zones).toMatchObject({ model: 'studio', counts: { high: 5, medium: 9, low: 2 }, rules: expect.stringMatching(/centre-most/) })

    const plants = [{ plantId: 'jalapeno', count: 25 }]
    const l = await body('plan_layout', { model: 'home', plants }) as unknown as PlanResult
    const allow = l.suggestions.find(s => s.kind === 'allow_lower')
    expect(allow?.overrides).toEqual({ allowedZones: { jalapeno: ['high', 'medium', 'low'] } })
    const again = await body('plan_layout', { model: 'home', plants, overrides: allow?.overrides }) as unknown as PlanResult
    expect(again.unplaced).toEqual([])
    const saved = await body('save_plan', { id: 'm1', name: 'Hot', model: 'home', plants, overrides: { pins: [{ slot: 1, plantId: 'jalapeno' }] } }) as unknown as { layout: PlanResult }
    expect(saved.layout.assignments.find(x => x.slot === 1)).toMatchObject({ plantId: 'jalapeno', reason: 'pinned to pod 1 by the caller (low light; ideal high)' })
    await client.close()
  })
})
