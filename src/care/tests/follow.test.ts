import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { PUMP_PRESETS, presetSchedules } from '../../scheduler/pumpPlan'
import { MemoryStore } from '../../store/memory'
import { CareEngine } from '../engine'
import { FOLLOW_ALERT, followGrowCycle } from '../follow'

const day = (n: number) => new Date(Date.parse('2026-11-09T12:00:00Z') + n * 86_400_000)
const light = { id: 'gardyn', kind: 'light' as const, name: 'Gardyn day', enabled: true, days: 127, spec: { setpoints: [{ minute: 330, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1290, level: 0 }] } }

function tower(o: { plant?: string, cycles?: 'seedlings' | 'young' | 'hand' | 'none' } = {}) {
  const store = new MemoryStore(30)
  store.schedules.upsert(light)
  store.pods.update(1, { plant: o.plant ?? 'Basil', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
  const cycles = o.cycles ?? 'seedlings'
  if (cycles === 'hand') store.schedules.upsert({ id: 'mine', kind: 'pump', name: 'My watering', enabled: true, days: 127, spec: { minute: 450, durationS: 420 } })
  else if (cycles !== 'none') {
    const p = PUMP_PRESETS.find(x => x.id === cycles)
    if (!p) throw new Error(`no preset ${cycles}`)
    for (const s of presetSchedules(p, { enabled: true, light: { on: 360, off: 1260 } })) store.schedules.upsert(s)
  }
  return store
}
const pumps = (store: MemoryStore) => store.schedules.list().filter(s => s.kind === 'pump').map(s => s.id).sort()

describe('watering follows the grow cycle', () => {
  it('moves seedling cycles to the young plants\' preset once the seedling week is over', () => {
    const store = tower()
    expect(followGrowCycle(store, day(5))).toBeNull()
    const change = followGrowCycle(store, day(9))
    expect(change).toMatchObject({ from: 'seedlings', to: 'young', days: 9 })
    expect(change?.detail).toMatch(/^Watering moved to .*: 2 × 6 min \(08:00, 16:00\), day 9 since sowing\./)
    expect(pumps(store)).toEqual(['water-young-0800', 'water-young-1600'])
    // Once moved, nothing more to do until the next stage.
    expect(followGrowCycle(store, day(10))).toBeNull()
    expect(followGrowCycle(store, day(23))).toMatchObject({ from: 'young', to: 'mature' })
  })

  it('starts the stage\'s preset on a tower with no cycles, and dates from the grow cycle when there is one', () => {
    const store = tower({ cycles: 'none' })
    store.grow.start('2026-10-01T00:00:00Z', 'Autumn')
    expect(followGrowCycle(store, day(0))).toMatchObject({ from: null, to: 'mature' })
    expect(pumps(store)).toEqual(['water-mature-0800', 'water-mature-1400', 'water-mature-2000'])
  })

  it('leaves hand-made cycles, the soak, an empty tower and a unit that has it off alone', () => {
    const hand = tower({ cycles: 'hand' })
    expect(followGrowCycle(hand, day(9))).toBeNull()
    expect(pumps(hand)).toEqual(['mine'])
    expect(followGrowCycle(tower({ cycles: 'none' }), day(1))).toBeNull()
    const empty = new MemoryStore(30)
    expect(followGrowCycle(empty, day(9))).toBeNull()
    const off = tower()
    off.settings.update({ followGrowCycle: false })
    expect(followGrowCycle(off, day(9))).toBeNull()
    expect(pumps(off)).toEqual(['water-seedlings-0800'])
  })

  it('goes straight to the fruiting preset when a fruiting crop is planted', () => {
    const store = tower({ plant: 'Jalapeño' })
    expect(followGrowCycle(store, day(4))).toMatchObject({ to: 'fruiting' })
  })

  it('raises a notice and says the schedules changed when the care engine moves them', () => {
    const store = tower()
    const events = createEventBus()
    const seen: string[] = []
    events.subscribe((e) => {
      if (e.kind === 'schedule') seen.push(e.id)
    })
    const care = new CareEngine({ store, hal: new SimHal({ tickMs: 0, now: () => day(9) }), events, now: () => day(9) })
    expect(care.tick().followed).toMatchObject({ to: 'young' })
    expect(store.alerts.list({ activeOnly: true }).find(a => a.kind === FOLLOW_ALERT)?.detail).toMatch(/Watering moved to/)
    expect(seen).toContain('follow:young')
    expect(care.tick().followed).toBeNull()
  })
})

describe('grow cycle start date', () => {
  function caller() {
    const store = new MemoryStore(30)
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, events: createEventBus(), version: 'test', now: () => day(1) })
    return { core, c: createCallerFactory(appRouter)(core.ctx) }
  }

  it('backdates a cycle to the sowing day, but not into the future', async () => {
    const { c } = caller()
    expect((await c.grow.start({ notes: 'Order', startedAt: '2026-11-09' })).startedAt).toBe('2026-11-09T00:00:00.000Z')
    await expect(c.grow.start({ notes: '', startedAt: '2026-12-01' })).rejects.toThrow(/in the future/)
    await expect(c.grow.start({ notes: '', startedAt: 'soon' })).rejects.toThrow(/must be a date/)
  })

  it('takes started_at over MCP, and pump_presets says whether watering follows the cycle', async () => {
    const { core } = caller()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(core.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const body = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]?.text ?? '')
    expect(await body('grow_cycle', { action: 'start', started_at: '2026-11-09' })).toMatchObject({ startedAt: '2026-11-09T00:00:00.000Z' })
    expect(await body('pump_presets', {})).toMatchObject({ followGrowCycle: true, daysSinceSowing: 1 })
    await client.close()
  })
})
