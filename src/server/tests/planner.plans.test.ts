import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import type { OrderResult } from '../../plants/match'
import type { PlanResult, SowingWave } from '../../plants/planner'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

interface Plan { id: string, name: string, model: string, mode: 'staggered' | 'batch', request: { plantId: string, count: number }[], layout: PlanResult, sowing: SowingWave[], start: string | null, appliedAt: string | null }

function setup() {
  let now = new Date('2026-11-02T12:00:00Z')
  const store = new MemoryStore(30)
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', now: () => now })
  return { store, core, c: createCallerFactory(appRouter)(core.ctx), setNow: (iso: string) => (now = new Date(iso)) }
}

async function mcp(ctx: ReturnType<typeof setup>['core']['ctx']) {
  const server = createMcpServer(ctx)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const body = (r.content as Array<{ text: string }>)[0]?.text ?? ''
    if (r.isError) throw new Error(body)
    return JSON.parse(body) as T
  }
  return { client, call }
}

describe('plan mode over MCP', () => {
  it('order → match → save → reload: the web planner recomputes the same layout and sowing', async () => {
    const { core, c, setNow } = setup()
    const { client, call } = await mcp(core.ctx)
    await c.grow.updatePod({ slot: 8, plant: 'Jalapeño', status: 'growing' })

    const order = await call<OrderResult>('match_order', { lines: ['Genovese Basil x9\n3 × Butterhead Lettuce yCube', 'Jalapeno Pepper x12', 'Dragonfruit x1'] })
    expect(order.plants).toEqual([{ plantId: 'basil', count: 9 }, { plantId: 'butterhead', count: 3 }, { plantId: 'jalapeno', count: 12 }])
    expect(order.unmatched.map(u => u.line)).toEqual(['Dragonfruit x1'])
    expect(order.matched.every(m => m.confidence >= 0.5)).toBe(true)

    // One of the twelve high slots is planted and medium is full: take the planner's suggestion so every jalapeño fits.
    const draft = await call<PlanResult>('plan_layout', { model: 'home', plants: order.plants })
    expect(draft.unplaced).toHaveLength(1)
    const overrides = draft.suggestions[0]?.overrides
    expect(overrides).toBeTruthy()
    const saved = await call<Plan>('save_plan', { id: 'order-1', name: 'Gardyn order', model: 'home', plants: order.plants, overrides })
    expect(saved.layout.unplaced).toEqual([])
    expect(saved.start).toBe('2026-11-02')

    expect(await call('list_plans')).toEqual([expect.objectContaining({ id: 'order-1', name: 'Gardyn order', plants: order.plants, placed: 24, unplaced: 0, start: '2026-11-02', appliedAt: null })])
    const got = await call<Plan>('get_plan', { id: 'order-1' })
    expect(got).toEqual(saved)

    // Weeks later the web planner opens it: the same request, overrides and start give the same layout and schedule.
    setNow('2026-12-20T09:00:00Z')
    const [opened] = await c.planner.plans()
    if (!opened) throw new Error('plan not listed')
    const layout = await c.planner.layout({ model: 'home', plants: opened.request, respectExisting: true, overrides: opened.layout.overrides })
    expect(layout).toEqual(saved.layout)
    expect(await c.planner.sowing({ plants: opened.request, mode: opened.mode, start: opened.start ?? undefined })).toEqual(saved.sowing)
    await client.close()
  })

  it('updates only the fields given, keeping the start date and overrides, and removes plans', async () => {
    const { core, c, setNow } = setup()
    const { client, call } = await mcp(core.ctx)
    const plants = [{ plantId: 'jalapeno', count: 13 }, { plantId: 'basil', count: 12 }]
    const draft = await c.planner.layout({ model: 'home', plants, respectExisting: true })
    const overrides = draft.suggestions[0]?.overrides ?? undefined
    await c.planner.savePlan({ id: 'p', name: 'Peppers', model: 'home', mode: 'staggered', plants, overrides })

    setNow('2027-01-15T09:00:00Z')
    const renamed = await call<Plan>('update_plan', { id: 'p', name: 'Hot peppers', mode: 'batch' })
    expect(renamed).toMatchObject({ name: 'Hot peppers', mode: 'batch', start: '2026-11-02', request: plants })
    expect(renamed.layout.overrides).toEqual(overrides)
    expect(renamed.layout.unplaced).toEqual([])
    expect(new Set(renamed.sowing.map(w => w.sowOn))).toEqual(new Set(['2026-11-02']))

    const fewer = await call<Plan>('update_plan', { id: 'p', plants: [{ plantId: 'mint', count: 2 }], start: '2027-02-01', overrides: null })
    expect(fewer).toMatchObject({ start: '2027-02-01', request: [{ plantId: 'mint', count: 2 }] })
    expect(fewer.layout.overrides).toBeUndefined()
    expect((await c.planner.updatePlan({ id: 'p', model: 'studio' })).layout.model).toBe('studio')

    await expect(call('update_plan', { id: 'missing', name: 'x' })).rejects.toThrow(/plan not found/)
    await expect(call('get_plan', { id: 'missing' })).rejects.toThrow(/plan not found/)
    expect(await call('remove_plan', { id: 'p' })).toEqual({ removed: true })
    expect(await call('list_plans')).toEqual([])
    await client.close()
  })

  it('replants: lays out over planted pods, moves each plant with its sow date, and empties what it leaves out', async () => {
    const { store, c, setNow } = setup()
    setNow('2026-11-09T10:00:00Z')
    await c.grow.updatePod({ slot: 2, plant: 'Catnip', status: 'seeded', plantedAt: '2026-11-09' })
    await c.grow.updatePod({ slot: 7, plant: 'Bunching Onions', status: 'seeded', plantedAt: '2026-11-09' })
    await c.grow.updatePod({ slot: 12, plant: 'Kale', status: 'growing', plantedAt: '2026-10-20' })
    setNow('2026-11-10T22:00:00Z')
    const plants = [{ plantId: 'catnip', count: 1 }, { plantId: 'bunching-onions', count: 1 }]
    const pins = [{ slot: 29, plantId: 'catnip' }, { slot: 2, plantId: 'bunching-onions' }]

    // Without replant, pod 2 is taken; with it, the tower is laid out afresh.
    expect((await c.planner.layout({ model: 'home', plants, respectExisting: true, overrides: { pins } })).unplaced.map(u => u.code)).toContain('bad_pin')
    const saved = await c.planner.savePlan({ id: 'r', name: 'Remap', model: 'home', mode: 'batch', plants, start: '2026-11-09', overrides: { pins, replant: true } })
    expect(saved.layout.unplaced).toEqual([])
    expect(saved.layout.assignments.map(a => [a.slot, a.plantId])).toEqual([[2, 'bunching-onions'], [29, 'catnip']])
    expect((await c.planner.layout({ model: 'home', plants, respectExisting: true, overrides: saved.layout.overrides ?? undefined })).assignments).toEqual(saved.layout.assignments)

    await c.planner.applyPlan({ id: 'r' })
    const pod = (slot: number) => store.pods.list().find(p => p.slot === slot)
    expect(pod(29)).toMatchObject({ plant: 'Catnip', plantedAt: '2026-11-09', status: 'seeded', notes: expect.stringContaining('moved from pod 2') })
    expect(pod(2)).toMatchObject({ plant: 'Bunching Onions', plantedAt: '2026-11-09', status: 'seeded', notes: expect.stringContaining('moved from pod 7') })
    // Kale isn't in the plan, and onions left pod 7.
    expect(pod(7)).toMatchObject({ plant: null, status: 'empty' })
    expect(pod(12)).toMatchObject({ plant: null, status: 'empty' })
  })

  it('serves an empty plan with no start date', async () => {
    const { c } = setup()
    expect((await c.planner.savePlan({ id: 'e', name: 'Empty', model: 'home', mode: 'staggered', plants: [] })).start).toBeNull()
    expect((await c.planner.updatePlan({ id: 'e', name: 'Still empty' })).sowing).toEqual([])
    expect(await c.planner.matchOrder({ lines: ['Mint x2'] })).toMatchObject({ plants: [{ plantId: 'mint', count: 2 }] })
    expect((await c.planner.matchOrder({ lines: ['Pink Swiss Chard'] })).unmatched[0]?.suggestions[0]).toMatchObject({ plantId: 'red-swiss-chard', reason: 'colour differs (pink; catalog has red)' })
  })
})
