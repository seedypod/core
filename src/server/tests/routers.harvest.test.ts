import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

const now = new Date('2026-03-01T12:00:00Z')

function setup() {
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test' })
  const ctx = { ...core.ctx, now: () => now }
  const events: string[] = []
  ctx.events.subscribe((e) => {
    if (e.kind === 'mutation') events.push(e.path)
  })
  return { ctx, events, c: createCallerFactory(appRouter)(ctx) }
}

describe('harvest and plant profiles (ADR-0022)', () => {
  it('upserts, lists and removes profiles, refusing a window that ends before it starts', async () => {
    const { c, events } = setup()
    const out = await c.plants.upsert({ profiles: [{ name: 'Kale', harvestMinDays: 30, harvestMaxDays: 45 }, { name: 'Basil', targetCover: 0.3, source: 'agent' }] })
    expect(out.map(p => [p.key, p.source])).toEqual([['kale', 'user'], ['basil', 'agent']])
    expect((await c.plants.list()).map(p => p.name)).toEqual(['Basil', 'Kale'])
    await expect(c.plants.upsert({ profiles: [{ name: 'Mint', harvestMinDays: 40, harvestMaxDays: 20 }] })).rejects.toThrow(/must not exceed/)
    expect(await c.plants.remove({ name: 'kale' })).toEqual({ removed: true })
    expect(await c.plants.remove({ name: 'kale' })).toEqual({ removed: false })
    expect(events).toEqual(['plants', 'plants'])
  })

  it('gives each planted pod an outlook from its profile, and a cut sends it back to growing', async () => {
    const { c, events } = setup()
    await c.grow.updatePod({ slot: 2, plant: 'Arugula', plantedAt: '2026-02-10T12:00:00Z', status: 'harvest' })
    await c.plants.upsert({ profiles: [{ name: 'Arugula', harvestMinDays: 17, harvestMaxDays: 25 }] })
    const [o] = await c.grow.harvest()
    expect(o).toMatchObject({ slot: 2, state: 'ready', daysLeft: 6, profile: 'Arugula', window: { start: 17, end: 25, source: 'profile' } })
    const cut = await c.grow.markHarvested({ slot: 2 })
    expect(cut).toMatchObject({ status: 'growing', lastHarvestAt: now.toISOString(), statusSince: now.toISOString() })
    expect((await c.grow.harvest())[0]).toMatchObject({ state: 'unknown', window: null, reason: 'Cut recently; waiting for photos of the regrowth.' })
    expect(events).toContain('pods')
  })

  it('lets an agent fill profiles in and read the outlook over MCP', async () => {
    const { ctx } = setup()
    ctx.store.pods.update(4, { plant: 'Red Russian Kale', status: 'growing', plantedAt: '2026-02-20T12:00:00Z' }, 't')
    const server = createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const body = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((((await client.callTool({ name, arguments: args })).content) as Array<{ text: string }>)[0]?.text ?? 'null') as unknown
    await body('set_plant_profiles', { profiles: [{ name: 'Kale', harvest_min_days: 30, harvest_max_days: 45, target_cover: 0.5, notes: 'baby leaf earlier' }] })
    expect(await body('plant_profiles')).toMatchObject([{ name: 'Kale', source: 'agent', targetCover: 0.5, notes: 'baby leaf earlier' }])
    expect(await body('harvest_outlook')).toMatchObject([{ slot: 4, state: 'growing', profile: 'Kale', daysToReady: 21, reason: '21 d until its 30–45 d window.' }])
    expect(await body('mark_harvested', { slot: 4 })).toMatchObject({ slot: 4, status: 'growing' })
    expect(await body('remove_plant_profile', { name: 'Kale' })).toEqual({ removed: true })
    await client.close()
  })
})
