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
    // Herbs take one zone brighter by default; this lovage is kept to low.
    await c.planner.addPlant({ ...okra, name: 'Lovage', zone: 'low', category: 'herb', size: 'normal', tolerates: [] })
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

    // Back to its category's default, it takes the medium zone too.
    expect(await c.planner.updatePlant({ id: 'lovage', tolerates: null })).toMatchObject({ tolerates: [{ zone: 'medium', cost: 2 }] })
    expect((await c.planner.layout({ model: 'home', plants: [{ plantId: 'lovage', count: 6 }], respectExisting: true })).assignments).toHaveLength(6)
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
    expect((await call('add_plant', { name: 'Okra', category: 'fruiting', zone: 'high', harvest_months: [2, 3], size: 'large', care_level: 'intermediate' })).body).toMatchObject({ id: 'okra', custom: true, careLevel: 'intermediate', tolerates: [{ zone: 'medium', cost: 1 }] })
    expect((await call('add_plant', { name: 'Lovage', category: 'herb', zone: 'medium', harvest_months: [1, 2], succession: 'fast-greens', tolerates: ['low'] })).body).toMatchObject({ size: 'normal', careLevel: null, succession: 'fast-greens', tolerates: [{ zone: 'low', cost: 1 }] })
    expect(store.customPlants.get('lovage')?.tolerates).toEqual(['low'])
    expect(store.customPlants.get('okra')?.source).toBe('agent')
    expect((await call('plant_catalog', { custom: true })).body).toEqual([
      expect.objectContaining({ id: 'okra', custom: true, size: 'large', succession: 'long-fruiting' }),
      expect.objectContaining({ id: 'lovage', custom: true, tolerates: [{ zone: 'low', cost: 1 }] }),
    ])
    expect((await call('update_plant', { id: 'lovage', tolerates: null })).body).toMatchObject({ tolerates: [{ zone: 'low', cost: 1 }, { zone: 'high', cost: 2 }] })

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

describe('plant care', () => {
  it('gives a plant\'s thinning count, timings, size, temperature and notes, by id or name', async () => {
    const { c } = setup()
    const basil = await c.planner.care({ id: 'basil' })
    expect(basil).toMatchObject({ thinTo: 3, thinEstimated: false, sproutDays: [5, 21], sproutEstimated: false, maturityDays: [68, 68], heightFt: '<1', tempF: [70, 85], fullDose: 'leavesOrRoots', latinName: 'Ocimum basilicum', url: 'https://help.mygardyn.com/en/articles/1783873' })
    expect(basil.notes?.harvest).toMatch(/1\/4 to 1\/2 inch above the nodes/)
    expect((await c.planner.care({ id: 'Chives' })).thinTo).toBe('all')
    expect((await c.planner.care({ id: 'pink-petunia' })).notes).toBeNull()
    await expect(c.planner.care({ id: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('falls back to the rule for its kind for a custom plant, with no page or notes', async () => {
    const { c } = setup()
    await c.planner.addPlant({ ...okra, careLevel: null })
    expect(await c.planner.care({ id: 'okra' })).toMatchObject({ thinTo: 1, thinEstimated: true, maturityDays: null, url: null, notes: null, sproutEstimated: true })
  })

  it('reaches agents as plant_care, and plant_catalog lists each plant\'s count', async () => {
    const { core } = setup()
    const server = createMcpServer(core.ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const body = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]?.text ?? '') as unknown
    expect(await body('plant_care', { id: 'cucumber' })).toMatchObject({ thinTo: 1, notes: { pollinate: expect.stringMatching(/only female flowers/) } })
    expect(await body('plant_catalog', { q: 'arugula' })).toEqual([expect.objectContaining({ id: 'arugula', thinTo: 'all' })])
    await client.close()
  })
})
