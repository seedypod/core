import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createMcpServer } from '../../mcp/server'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function rig() {
  const store = new MemoryStore(30)
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, events: createEventBus(), version: 'test', now: () => new Date('2026-11-11T01:00:00Z') })
  return { store, core, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('grow.swapPods', () => {
  it('swaps plant, sow date, status, notes and last cut between two pods', async () => {
    const { store, c } = rig()
    await c.grow.updatePod({ slot: 2, plant: 'Catnip', plantedAt: '2026-11-09', status: 'seeded', notes: 'low light zone' })
    await c.grow.markHarvested({ slot: 7 })
    await c.grow.updatePod({ slot: 7, plant: 'Basil', plantedAt: '2026-10-20', notes: 'pinch tops' })
    const out = await c.grow.swapPods({ a: 2, b: 7 })
    expect(out.map(p => p.slot)).toEqual([2, 7])
    const pod = (slot: number) => store.pods.list().find(p => p.slot === slot)
    expect(pod(2)).toMatchObject({ plant: 'Basil', plantedAt: '2026-10-20', status: 'growing', notes: 'pinch tops', lastHarvestAt: '2026-11-11T01:00:00.000Z' })
    expect(pod(7)).toMatchObject({ plant: 'Catnip', plantedAt: '2026-11-09', status: 'seeded', notes: 'low light zone', lastHarvestAt: null })
  })

  it('leaves a pod swapped with itself alone, and refuses a pod that isn\'t there', async () => {
    const { c } = rig()
    await c.grow.updatePod({ slot: 3, plant: 'Mint', status: 'growing' })
    expect((await c.grow.swapPods({ a: 3, b: 3 }))[0]).toMatchObject({ slot: 3, plant: 'Mint' })
    await expect(c.grow.swapPods({ a: 3, b: 45 })).rejects.toThrow(/no pod 45/)
    await expect(c.grow.swapPods({ a: 44, b: 3 })).rejects.toThrow(/no pod 44/)
  })

  it('swaps over MCP', async () => {
    const { core, store } = rig()
    store.pods.update(4, { plant: 'Oregano', status: 'seeded' }, '2026-11-09T00:00:00Z')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(core.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const r = await client.callTool({ name: 'swap_pods', arguments: { a: 4, b: 8 } })
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? '')).toMatchObject([{ slot: 4, plant: null }, { slot: 8, plant: 'Oregano' }])
    await client.close()
  })
})
