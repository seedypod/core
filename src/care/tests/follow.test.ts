import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { zonedMidnight } from '../../server/routers/grow'
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

  it('dates from the grow cycle when there is one', () => {
    const store = tower()
    store.grow.start('2026-10-01T00:00:00Z', 'Autumn')
    expect(followGrowCycle(store, day(0))).toMatchObject({ from: 'seedlings', to: 'mature' })
    expect(pumps(store)).toEqual(['water-mature-0800', 'water-mature-1400', 'water-mature-2000'])
  })

  it('never creates cycles where there are none, or touches preset cycles that were paused or trimmed', () => {
    const none = tower({ cycles: 'none' })
    expect(followGrowCycle(none, day(9))).toBeNull()
    expect(pumps(none)).toEqual([])
    const paused = tower()
    const seed = paused.schedules.list().find(s => s.kind === 'pump')
    if (!seed) throw new Error('no seedling cycle')
    paused.schedules.upsert({ ...seed, enabled: false })
    expect(followGrowCycle(paused, day(9))).toBeNull()
    paused.schedules.upsert({ ...seed, enabled: true, days: 31 })
    expect(followGrowCycle(paused, day(9))).toBeNull()
    paused.schedules.upsert({ ...seed, days: 127, spec: { minute: 480, durationS: 420 } })
    expect(followGrowCycle(paused, day(9))).toBeNull()
  })

  it('keeps following a light-clipped preset after the light schedule changes', () => {
    const store = tower({ plant: 'Jalapeño', cycles: 'none' })
    // Fruiting applied under a 06:00–21:00 day: four runs.
    const fruiting = PUMP_PRESETS.find(p => p.id === 'fruiting')
    if (!fruiting) throw new Error('no fruiting preset')
    for (const s of presetSchedules(fruiting, { enabled: true, light: { on: 360, off: 1260 } })) store.schedules.upsert(s)
    store.schedules.upsert({ ...light, spec: { setpoints: [{ minute: 300, level: 0 }, { minute: 330, level: 100 }, { minute: 1350, level: 100 }, { minute: 1380, level: 0 }] } })
    store.pods.update(1, { plant: 'Basil' }, '2026-11-09T12:00:00Z')
    expect(followGrowCycle(store, day(9))).toMatchObject({ from: 'fruiting', to: 'young' })
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

  it('goes straight to the fruiting preset when a fruiting crop is planted, but not during the soak', () => {
    const store = tower({ plant: 'Jalapeño' })
    expect(followGrowCycle(store, day(1))).toBeNull()
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

  it('runs one tick at a time when its own schedule change asks for another', () => {
    const store = tower()
    const events = createEventBus()
    const care = new CareEngine({ store, hal: new SimHal({ tickMs: 0, now: () => day(9) }), events, now: () => day(9) })
    const tick = vi.spyOn(care, 'tick')
    let depth = 0
    let deepest = 0
    tick.mockImplementation(function (this: CareEngine) {
      depth++
      deepest = Math.max(deepest, depth)
      try {
        return CareEngine.prototype.tick.call(this)
      }
      finally {
        depth--
      }
    })
    care.start()
    care.stop()
    expect(deepest).toBe(1)
    // The start tick moved the watering and its schedule event asked for one more, run after it.
    expect(tick).toHaveBeenCalledTimes(2)
    expect(pumps(store)).toEqual(['water-young-0800', 'water-young-1600'])
  })
})

describe('grow cycle start date', () => {
  function caller() {
    const store = new MemoryStore(30)
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, events: createEventBus(), version: 'test', now: () => day(1) })
    return { core, c: createCallerFactory(appRouter)(core.ctx) }
  }

  it('backdates a cycle to the sowing day at midnight on the unit\'s calendar, within bounds', async () => {
    const { core, c } = caller()
    core.ctx.store.settings.update({ timezone: 'America/Los_Angeles' })
    expect((await c.grow.start({ notes: 'Order', startedAt: '2026-11-09' })).startedAt).toBe('2026-11-09T08:00:00.000Z')
    await expect(c.grow.start({ notes: '', startedAt: '2026-12-01' })).rejects.toThrow(/after today/)
    await expect(c.grow.start({ notes: '', startedAt: '2026-11-08' })).rejects.toThrow(/before the open cycle began/)
    await c.grow.end()
    await expect(c.grow.start({ notes: '', startedAt: '2026-01-01' })).rejects.toThrow(/more than 120 days ago/)
    await expect(c.grow.start({ notes: '', startedAt: '1' })).rejects.toThrow(/YYYY-MM-DD/)
  })

  it('takes today on a unit east of UTC, where it\'s already tomorrow', async () => {
    const { core, c } = caller()
    core.ctx.store.settings.update({ timezone: 'Australia/Sydney' })
    // 2026-11-10T12:00Z is 23:00 on the 10th in Sydney; the 11th would be the future there too.
    expect((await c.grow.start({ notes: '', startedAt: '2026-11-10' })).startedAt).toBe('2026-11-09T13:00:00.000Z')
    expect(zonedMidnight('2026-11-09', 'UTC').toISOString()).toBe('2026-11-09T00:00:00.000Z')
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
