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
import { PUMP_PRESETS, presetSchedules, type PumpPresetId } from '../../scheduler/pumpPlan'
import { MemoryStore } from '../../store/memory'
import { CareEngine } from '../engine'
import { FOLLOW_ALERT, followedPreset } from '../follow'
import { followGrowCycle } from '../protocol'

const day = (n: number) => new Date(Date.parse('2026-11-09T12:00:00Z') + n * 86_400_000)
const light = { id: 'gardyn', kind: 'light' as const, name: 'Gardyn day', enabled: true, days: 127, spec: { setpoints: [{ minute: 330, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1290, level: 0 }] } }

// Sown on Monday 9 November: weekday 0, the day germination's weekly cycle runs.
function tower(o: { plant?: string, cycles?: PumpPresetId | 'hand' | 'none' } = {}) {
  const store = new MemoryStore(30)
  store.schedules.upsert(light)
  store.pods.update(1, { plant: o.plant ?? 'Basil', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
  const cycles = o.cycles ?? 'germination'
  if (cycles === 'hand') store.schedules.upsert({ id: 'mine', kind: 'pump', name: 'My watering', enabled: true, days: 127, spec: { minute: 450, durationS: 420 } })
  else if (cycles !== 'none') {
    const p = PUMP_PRESETS.find(x => x.id === cycles)
    if (!p) throw new Error(`no preset ${cycles}`)
    for (const s of presetSchedules(p, { enabled: true, light: { on: 360, off: 1260 }, weekday: 0 })) store.schedules.upsert(s)
  }
  return store
}
const pumps = (store: MemoryStore) => store.schedules.list().filter(s => s.kind === 'pump').map(s => s.id).sort()

describe('watering follows the grow cycle', () => {
  it('moves germination\'s weekly cycle to the seedlings\' daily one on day 8, after its day-7 run, then on through the stages', () => {
    const store = tower()
    expect(store.schedules.list().find(s => s.kind === 'pump')).toMatchObject({ id: 'water-germination-0800', days: 1, spec: { minute: 480, durationS: 900 } })
    // Day 7 is germination's second run: it stays.
    expect(followGrowCycle(store, day(7))).toBeNull()
    const change = followGrowCycle(store, day(8))
    expect(change).toMatchObject({ from: 'germination', to: 'seedlings', days: 8 })
    expect(change?.detail).toMatch(/^Watering moved to Seedlings: 1 × 10 min \(08:00\), day 8 since sowing\./)
    expect(pumps(store)).toEqual(['water-seedlings-0800'])
    // Once moved, nothing more to do until the next stage.
    expect(followGrowCycle(store, day(13))).toBeNull()
    expect(followGrowCycle(store, day(14))).toMatchObject({ from: 'seedlings', to: 'young' })
    expect(pumps(store)).toEqual(['water-young-0800', 'water-young-1600'])
    expect(followGrowCycle(store, day(23))).toMatchObject({ from: 'young', to: 'mature' })
  })

  it('never moves back: a new grow cycle over grown plants, or seedlings early, keep their cycles', () => {
    // Mature tomatoes on the fruiting preset; a new grow cycle starts today.
    const tomatoes = tower({ plant: 'Tomato', cycles: 'fruiting' })
    tomatoes.grow.start(day(4).toISOString(), 'New')
    expect(followGrowCycle(tomatoes, day(4))).toBeNull()
    expect(pumps(tomatoes)).toEqual(expect.arrayContaining(['water-fruiting-1000']))
    // Seedlings applied by hand on day 3: not back to the weekly run.
    const early = tower({ cycles: 'seedlings' })
    expect(followGrowCycle(early, day(3))).toBeNull()
    expect(pumps(early)).toEqual(['water-seedlings-0800'])
    // Mature cycles under a new grow cycle stay mature.
    const mature = tower({ cycles: 'mature' })
    mature.grow.start(day(4).toISOString(), 'New')
    expect(followGrowCycle(mature, day(4))).toBeNull()
    expect(pumps(mature)).toEqual(['water-mature-0800', 'water-mature-1400', 'water-mature-2000'])
  })

  it('keeps germination\'s run on the sowing weekday, moving it with a notice when the grow cycle restarts on another day', () => {
    const store = tower()
    // Restarted on Thursday the 12th on the unit's calendar.
    store.grow.start('2026-11-12T08:00:00Z', 'Again')
    const change = followGrowCycle(store, day(4))
    expect(change).toMatchObject({ from: 'germination', to: 'germination', days: 1 })
    expect(change?.detail).toMatch(/^Germination's weekly run moved to Thursdays, the sowing weekday: day 1 since sowing\./)
    expect(store.schedules.list().find(s => s.kind === 'pump')).toMatchObject({ id: 'water-germination-0800', days: 1 << 3 })
    expect(followGrowCycle(store, day(5))).toBeNull()
    // A germination cycle on two days isn't the preset as written: left alone.
    const two = tower()
    const g = two.schedules.list().find(s => s.kind === 'pump')
    if (!g) throw new Error('no germination cycle')
    two.schedules.upsert({ ...g, days: 3 })
    expect(followGrowCycle(two, day(8))).toBeNull()
  })

  it('dates from the grow cycle when there is one', () => {
    const store = tower()
    store.grow.start('2026-10-01T00:00:00Z', 'Autumn')
    expect(followGrowCycle(store, day(0))).toMatchObject({ from: 'germination', to: 'mature' })
    expect(pumps(store)).toEqual(['water-mature-0800', 'water-mature-1400', 'water-mature-2000'])
  })

  it('never creates cycles where there are none, or touches preset cycles that were paused or trimmed', () => {
    const none = tower({ cycles: 'none' })
    expect(followGrowCycle(none, day(9))).toBeNull()
    expect(pumps(none)).toEqual([])
    const paused = tower()
    const seed = paused.schedules.list().find(s => s.kind === 'pump')
    if (!seed) throw new Error('no germination cycle')
    paused.schedules.upsert({ ...seed, enabled: false })
    expect(followGrowCycle(paused, day(9))).toBeNull()
    paused.schedules.upsert({ ...seed, enabled: true, days: 127 })
    expect(followGrowCycle(paused, day(9))).toBeNull()
    paused.schedules.upsert({ ...seed, days: 1, spec: { minute: 480, durationS: 420 } })
    expect(followGrowCycle(paused, day(9))).toBeNull()
  })

  it('still knows a light-clipped preset after the light schedule changes', () => {
    const store = tower({ plant: 'Jalapeño', cycles: 'none' })
    // Fruiting applied under a 06:00–21:00 day: four runs.
    const fruiting = PUMP_PRESETS.find(p => p.id === 'fruiting')
    if (!fruiting) throw new Error('no fruiting preset')
    for (const s of presetSchedules(fruiting, { enabled: true, light: { on: 360, off: 1260 }, weekday: 0 })) store.schedules.upsert(s)
    store.schedules.upsert({ ...light, spec: { setpoints: [{ minute: 300, level: 0 }, { minute: 330, level: 100 }, { minute: 1350, level: 100 }, { minute: 1380, level: 0 }] } })
    expect(followedPreset(store.schedules.list().filter((s): s is typeof s & { spec: { minute: number, durationS: number } } => s.kind === 'pump'))?.id).toBe('fruiting')
    // Fruiting is a track of its own: with the crop gone it doesn't drop to seedlings.
    store.pods.update(1, { plant: 'Basil' }, '2026-11-09T12:00:00Z')
    expect(followGrowCycle(store, day(9))).toBeNull()
  })

  it('leaves hand-made cycles, a tower with no cycles, an empty tower and a unit that has it off alone', () => {
    const hand = tower({ cycles: 'hand' })
    expect(followGrowCycle(hand, day(9))).toBeNull()
    expect(pumps(hand)).toEqual(['mine'])
    expect(followGrowCycle(tower({ cycles: 'none' }), day(1))).toBeNull()
    const empty = new MemoryStore(30)
    expect(followGrowCycle(empty, day(9))).toBeNull()
    const off = tower()
    off.settings.update({ followGrowCycle: false })
    expect(followGrowCycle(off, day(9))).toBeNull()
    expect(pumps(off)).toEqual(['water-germination-0800'])
  })

  it('moves a fruiting crop from germination straight to the fruiting preset on day 8', () => {
    const store = tower({ plant: 'Jalapeño' })
    expect(followGrowCycle(store, day(7))).toBeNull()
    expect(followGrowCycle(store, day(8))).toMatchObject({ from: 'germination', to: 'fruiting' })
  })

  it('raises a notice and says the schedules changed when the care engine moves them', () => {
    const store = tower()
    const events = createEventBus()
    const seen: string[] = []
    events.subscribe((e) => {
      if (e.kind === 'schedule') seen.push(e.id)
    })
    const care = new CareEngine({ store, hal: new SimHal({ tickMs: 0, now: () => day(9) }), events, now: () => day(9) })
    expect(care.tick().followed).toMatchObject({ to: 'seedlings' })
    expect(store.alerts.list({ activeOnly: true }).find(a => a.kind === FOLLOW_ALERT)?.detail).toMatch(/Watering moved to/)
    expect(seen).toContain('follow:seedlings')
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
    expect(pumps(store)).toEqual(['water-seedlings-0800'])
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

  it('finds midnight on DST days, and the day\'s first instant where a jump skips it', async () => {
    // Sydney springs forward at 02:00 on 2026-10-04; midnight is still +10.
    expect(zonedMidnight('2026-10-04', 'Australia/Sydney').toISOString()).toBe('2026-10-03T14:00:00.000Z')
    // And falls back at 03:00 on 2026-04-05; midnight is still +11.
    expect(zonedMidnight('2026-04-05', 'Australia/Sydney').toISOString()).toBe('2026-04-04T13:00:00.000Z')
    // Santiago jumps 00:00 → 01:00 on 2026-09-06: the day starts at 01:00 (-3).
    expect(zonedMidnight('2026-09-06', 'America/Santiago').toISOString()).toBe('2026-09-06T04:00:00.000Z')
    const { c } = caller()
    await expect(c.grow.start({ notes: '', startedAt: '2026-02-30' })).rejects.toThrow(/not a real date/)
    await expect(c.grow.start({ notes: '', startedAt: '2026-13-01' })).rejects.toThrow(/not a real date/)
  })

  it('moves the open cycle to another sowing day on the unit\'s calendar, and germination follows it', async () => {
    const { core, c } = caller()
    const store = core.ctx.store
    store.settings.update({ timezone: 'America/Los_Angeles' })
    // The date is checked first, then whether there's a cycle to move.
    await expect(c.grow.setStart({ startedAt: '2026-11-11' })).rejects.toThrow(/after today/)
    await expect(c.grow.setStart({ startedAt: '2026-11-09' })).rejects.toThrow(/No open grow cycle/)
    // No pods planted yet: the cycle's start alone dates germination.
    await c.grow.start({ notes: '', startedAt: '2026-11-09' })
    for (const sch of presetSchedules(PUMP_PRESETS[0] as typeof PUMP_PRESETS[number], { enabled: true, weekday: 0 })) store.schedules.upsert(sch)
    // day(1) is 04:00 on Tuesday the 10th in Los Angeles: "start germination today" is the 10th there.
    const moved = await c.grow.setStart({ startedAt: '2026-11-10' })
    expect(moved.startedAt).toBe('2026-11-10T08:00:00.000Z')
    expect(store.grow.current()?.startedAt).toBe('2026-11-10T08:00:00.000Z')
    // The weekly run moves to Tuesdays at once, with a notice.
    expect(store.schedules.list().find(s => s.kind === 'pump')?.days).toBe(1 << 1)
    expect(store.alerts.list({ activeOnly: true }).find(a => a.kind === FOLLOW_ALERT)?.detail).toMatch(/^Germination's weekly run moved to Tuesdays, the sowing weekday: day 0 since sowing\./)
    expect(followGrowCycle(store, day(1))).toBeNull()
    await expect(c.grow.setStart({ startedAt: '2026-11-11' })).rejects.toThrow(/after today/)
    await expect(c.grow.setStart({ startedAt: '2026-06-01' })).rejects.toThrow(/more than 120 days ago/)
    await expect(c.grow.setStart({ startedAt: '2026-02-30' })).rejects.toThrow(/not a real date/)
  })

  it('leaves germination\'s weekday alone while Follow is off, and cycles that aren\'t the preset as written', async () => {
    const { core, c } = caller()
    const store = core.ctx.store
    store.settings.update({ timezone: 'UTC', followGrowCycle: false })
    await c.grow.start({ notes: '', startedAt: '2026-11-09' })
    for (const sch of presetSchedules(PUMP_PRESETS[0] as typeof PUMP_PRESETS[number], { enabled: true, weekday: 0 })) store.schedules.upsert(sch)
    await c.grow.setStart({ startedAt: '2026-11-10' })
    expect(store.schedules.list().find(s => s.kind === 'pump')?.days).toBe(1)
    store.settings.update({ followGrowCycle: true })
    const germ = store.schedules.list().find(s => s.kind === 'pump')
    if (!germ) throw new Error('no germination cycle')
    store.schedules.upsert({ ...germ, enabled: false })
    await c.grow.setStart({ startedAt: '2026-11-09' })
    expect(store.schedules.list().find(s => s.kind === 'pump')?.days).toBe(1)
  })

  it('reads the moved cycle\'s reminders and stage from its new day', async () => {
    const { core, c } = caller()
    const store = core.ctx.store
    store.settings.update({ timezone: 'UTC' })
    await c.grow.start({ notes: '', startedAt: '2026-08-01' })
    for (const k of ['reminder_thinning', 'reminder_root_check', 'reminder_nutrients:1', 'reminder_nutrients:2', 'reminder_nutrients:3', 'custom']) store.grow.markIssued(k)
    await c.grow.setStage({ stage: 'harvest' })
    // Day 15: thinning (14) and the first two nutrient top-ups (7, 14) were due; root check (21) and the third (21) wait again.
    const moved = await c.grow.setStart({ startedAt: '2026-10-26' })
    expect(moved.issued).toEqual(['reminder_thinning', 'reminder_nutrients:1', 'reminder_nutrients:2', 'custom'])
    // Past the seedling days a harvest stays called.
    expect(moved.stage).toBe('harvest')
    // Back to the first days: germination, with nothing issued.
    expect(await c.grow.setStart({ startedAt: '2026-11-08' })).toMatchObject({ stage: 'germination', issued: ['custom'] })
    expect((await c.grow.setStart({ startedAt: '2026-10-30' })).stage).toBe('seedling')
    expect((await c.grow.setStart({ startedAt: '2026-10-20' })).stage).toBe('vegetative')
  })

  it('lets the care engine move watering on as soon as the sowing day moves, not at its next tick', async () => {
    const { core, c } = caller()
    const store = core.ctx.store
    store.settings.update({ timezone: 'UTC' })
    store.pods.update(1, { plant: 'Basil', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
    await c.grow.start({ notes: '', startedAt: '2026-11-09' })
    for (const sch of presetSchedules(PUMP_PRESETS[0] as typeof PUMP_PRESETS[number], { enabled: true, weekday: 0 })) store.schedules.upsert(sch)
    // The engine on the core's own event bus, its periodic tick far off.
    const care = new CareEngine({ store, hal: new SimHal({ tickMs: 0, now: () => day(1) }), events: core.ctx.events, now: () => day(1) })
    const tick = vi.spyOn(care, 'tick')
    care.start()
    try {
      expect(tick).toHaveBeenCalledTimes(1)
      const pumps = () => store.schedules.list().filter(s => s.kind === 'pump')
      expect(pumps().map(s => s.id)).toEqual(['water-germination-0800'])
      // Sown nine days ago after all: the grow event alone moves it from germination to seedlings.
      await c.grow.setStart({ startedAt: '2026-11-01' })
      expect(tick.mock.calls.length).toBeGreaterThan(1)
      expect(pumps().map(s => [s.id, s.days])).toEqual([['water-seedlings-0800', 127]])
    }
    finally {
      care.stop()
    }
  })

  it('starts germination today in one call, and a retry reuses the cycle it started', async () => {
    const { core, c } = caller()
    const store = core.ctx.store
    store.settings.update({ timezone: 'UTC' })
    store.schedules.upsert(light)
    store.schedules.upsert({ id: 'mine', kind: 'pump', name: 'My watering', enabled: true, days: 127, spec: { minute: 450, durationS: 420 } })
    // day(1) is Tuesday the 10th.
    const first = await c.grow.startGermination()
    expect(first.startedAt).toBe(day(1).toISOString())
    const pumpsNow = () => store.schedules.list().filter(s => s.kind === 'pump')
    expect(pumpsNow()).toEqual([expect.objectContaining({ id: 'water-germination-0800', days: 1 << 1, enabled: true, spec: { minute: 480, durationS: 900 } })])
    expect(store.schedules.list().some(s => s.id === 'gardyn')).toBe(true)
    const again = await c.grow.startGermination()
    expect(again.id).toBe(first.id)
    expect(store.grow.history()).toHaveLength(1)
    expect(pumpsNow()).toHaveLength(1)
  })

  it('starts a new cycle for germination when the open one began on another day', async () => {
    const { core, c } = caller()
    core.ctx.store.settings.update({ timezone: 'UTC' })
    const old = await c.grow.start({ notes: '', startedAt: '2026-11-01' })
    const fresh = await c.grow.startGermination()
    expect(fresh.id).not.toBe(old.id)
    expect(core.ctx.store.grow.history().find(x => x.id === old.id)?.endedAt).not.toBeNull()
  })

  it('takes today on a unit east of UTC when moving the start, and the care engine re-runs on it', async () => {
    const { core, c } = caller()
    core.ctx.store.settings.update({ timezone: 'Australia/Sydney' })
    await c.grow.start({ notes: '' })
    // 2026-11-10T12:00Z is 23:00 on the 10th in Sydney.
    expect((await c.grow.setStart({ startedAt: '2026-11-10' })).startedAt).toBe('2026-11-09T13:00:00.000Z')
    const seen: string[] = []
    core.ctx.events.subscribe(e => (e.kind === 'mutation' ? void seen.push(e.path) : undefined))
    await c.grow.setStart({ startedAt: '2026-11-09' })
    expect(seen).toContain('grow')
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
    expect(await body('grow_cycle', { action: 'set_start', started_at: '2026-11-10' })).toMatchObject({ startedAt: '2026-11-10T00:00:00.000Z' })
    expect(await body('pump_presets', {})).toMatchObject({ daysSinceSowing: 0 })
    expect((await client.callTool({ name: 'grow_cycle', arguments: { action: 'set_start' } })).isError).toBe(true)
    await client.close()
  })
})
