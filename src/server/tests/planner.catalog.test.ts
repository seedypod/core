import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import type { CoreEvent } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function setup() {
  const store = new MemoryStore(30)
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', now: () => new Date('2026-11-02T12:00:00Z') })
  const events: string[] = []
  core.ctx.events.subscribe((e: CoreEvent) => {
    if (e.kind === 'mutation') events.push(e.path)
  })
  return { store, core, events, c: createCallerFactory(appRouter)(core.ctx) }
}

const okra = { name: 'Okra', category: 'fruiting' as const, zone: 'high' as const, harvestMonths: [2, 3] as [number, number], size: 'large' as const }

describe('custom catalog plants', () => {
  it('adds, edits and removes a custom plant; built-in plants are read-only', async () => {
    const { c, store, events } = setup()
    const added = await c.planner.addPlant({ ...okra, careLevel: null, size: 'large' })
    expect(added).toMatchObject({ id: 'okra', custom: true, succession: 'long-fruiting', careLevel: null, size: 'large', inStore: false })
    expect(store.customPlants.get('okra')).toMatchObject({ source: 'user', createdAt: '2026-11-02T12:00:00.000Z' })
    expect(events).toContain('catalog')

    const edited = await c.planner.updatePlant({ id: 'okra', name: 'Okra Clemson', harvestMonths: [2, 4] })
    expect(edited).toMatchObject({ id: 'okra', name: 'Okra Clemson', harvestMonths: [2, 4], size: 'large', succession: 'long-fruiting' })
    expect(await c.planner.updatePlant({ id: 'okra', category: 'vegetable' })).toMatchObject({ category: 'vegetable', succession: 'fast-greens' })
    expect(await c.planner.updatePlant({ id: 'okra', category: 'legume', succession: 'flowers' })).toMatchObject({ succession: 'flowers' })

    await expect(c.planner.updatePlant({ id: 'basil', zone: 'low' })).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/read-only/) })
    await expect(c.planner.removePlant({ id: 'basil' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(c.planner.updatePlant({ id: 'nope', zone: 'low' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(c.planner.updatePlant({ id: 'okra', harvestMonths: [5, 2] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    expect(await c.planner.removePlant({ id: 'okra' })).toEqual({ removed: true })
    await expect(c.planner.removePlant({ id: 'okra' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses names already in the catalog and names with no letters', async () => {
    const { c } = setup()
    await expect(c.planner.addPlant({ ...okra, name: 'Basil!' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(c.planner.addPlant({ ...okra, name: 'Jalapeno' })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/built-in/) })
    await expect(c.planner.addPlant({ ...okra, name: '!!!' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(c.planner.addPlant({ ...okra, harvestMonths: [4, 1] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await c.planner.addPlant(okra)
    await c.planner.addPlant({ ...okra, name: 'Lovage', zone: 'low', category: 'herb', size: 'normal' })
    await expect(c.planner.addPlant(okra)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/update it instead/) })
    await expect(c.planner.updatePlant({ id: 'lovage', name: 'okra' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('serves custom plants to the catalog, layout, best spots, sowing and saved plans', async () => {
    const { c } = setup()
    await c.planner.addPlant({ ...okra, name: 'Lovage', zone: 'low', category: 'herb', size: 'normal' })
    expect((await c.planner.catalog({ custom: true })).plants.map(p => p.id)).toEqual(['lovage'])
    expect((await c.planner.catalog({ q: 'basil' })).plants.every(p => !p.custom)).toBe(true)
    expect(await c.planner.plant({ id: 'lovage' })).toMatchObject({ name: 'Lovage', custom: true })

    // A pod planted with the custom plant counts as that plant.
    await c.grow.updatePod({ slot: 1, plant: 'Lovage', status: 'growing' })
    const l = await c.planner.layout({ model: 'home', plants: [{ plantId: 'lovage', count: 6 }], respectExisting: true })
    expect(l.assignments).toHaveLength(5)
    expect(l.unplaced[0]?.blocking).toContainEqual({ slot: 1, zone: 'low', plantId: 'lovage', plantName: 'Lovage', existing: true })
    expect((await c.planner.bestSpots({ model: 'home', plantId: 'lovage', limit: 2 })).every(s => s.zone === 'low')).toBe(true)
    expect(await c.planner.sowing({ plants: [{ plantId: 'lovage', count: 2 }], mode: 'staggered', start: '2026-11-02' })).toHaveLength(2)
    const plan = await c.planner.savePlan({ id: 'p', name: 'Lovage', model: 'home', mode: 'batch', plants: [{ plantId: 'lovage', count: 2 }] })
    expect(plan.layout.assignments.map(a => a.plantName)).toEqual(['Lovage', 'Lovage'])
    expect(plan.sowing).toHaveLength(2)
  })

  it('lets an agent add, edit and remove plants over MCP and plan with them', async () => {
    const { core, store } = setup()
    const server = createMcpServer(core.ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args })
      const body = ((r.content as Array<{ text: string }>)[0]?.text ?? '')
      return { error: !!r.isError, body: r.isError ? body : JSON.parse(body) as unknown }
    }
    expect((await call('add_plant', { name: 'Okra', category: 'fruiting', zone: 'high', harvest_months: [2, 3], size: 'large', care_level: 'intermediate' })).body).toMatchObject({ id: 'okra', custom: true, careLevel: 'intermediate' })
    expect((await call('add_plant', { name: 'Lovage', category: 'herb', zone: 'medium', harvest_months: [1, 2], succession: 'fast-greens' })).body).toMatchObject({ size: 'normal', careLevel: null, succession: 'fast-greens' })
    expect(store.customPlants.get('okra')?.source).toBe('agent')
    expect((await call('plant_catalog', { custom: true })).body).toEqual([
      expect.objectContaining({ id: 'okra', custom: true, size: 'large', succession: 'long-fruiting' }),
      expect.objectContaining({ id: 'lovage', custom: true }),
    ])
    expect((await call('update_plant', { id: 'okra', harvest_months: [2, 4], care_level: null })).body).toMatchObject({ harvestMonths: [2, 4], careLevel: null, size: 'large' })
    const layout = (await call('plan_layout', { model: 'home', plants: [{ plantId: 'okra', count: 2 }] })).body as { assignments: { slotZone: string }[] }
    expect(layout.assignments.map(x => x.slotZone)).toEqual(['high', 'high'])
    expect(((await call('best_spot', { model: 'studio', plantId: 'okra' })).body as unknown[]).length).toBeGreaterThan(0)

    const refused = await call('update_plant', { id: 'basil', zone: 'low' })
    expect(refused.error).toBe(true)
    expect(refused.body).toMatch(/read-only/)
    expect((await call('remove_plant', { id: 'okra' })).body).toEqual({ removed: true })
    expect((await call('remove_plant', { id: 'mint' })).error).toBe(true)
    await client.close()
  })
})
