import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { PUMP_PRESETS, presetSchedules, type PumpPresetId } from '../../scheduler/pumpPlan'
import { MemoryStore } from '../../store/memory'
import { CareEngine } from '../engine'
import { activateEntry, activeEntryId, libraryEntry } from '../library'
import { readTower } from '../tower'
import { advanceProtocol, HARVEST_ALERT, holdProtocol, PROTOCOLS, protocolFor, protocolReport, protocolState, releaseProtocol, runProtocol, setProtocolThen, stageDiff, THEN_ALERT, type ProtocolStage } from '../protocol'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DAY = 86_400_000
// Sown on Monday 9 November, noon UTC; the unit is on UTC.
const SOWN = Date.parse('2026-11-09T12:00:00Z')
const day = (n: number) => new Date(SOWN + n * DAY)
const light = { id: 'gardyn', kind: 'light' as const, name: 'Gardyn day', enabled: true, days: 127, spec: { setpoints: [{ minute: 330, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1290, level: 0 }] } }
const summer = { id: 'summer', name: 'Summer', cycles: [{ minute: 420, durationS: 300, days: 127 }, { minute: 720, durationS: 300, days: 127 }, { minute: 1020, durationS: 300, days: 127 }, { minute: 1200, durationS: 300, days: 127 }], lightPresetId: null }

function tower(o: { plant?: string, cycles?: PumpPresetId | 'hand' | 'none', cycle?: boolean } = {}) {
  const store = new MemoryStore(30)
  store.schedules.upsert(light)
  store.pods.update(1, { plant: o.plant ?? 'Basil', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
  if (o.cycle ?? true) store.grow.start('2026-11-09T00:00:00.000Z')
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
const greens = PROTOCOLS[0]?.stages as readonly ProtocolStage[]
const stage = (id: string) => greens.find(s => s.id === id) as ProtocolStage

describe('grow protocols (ADR-0030)', () => {
  it('run their stages back to back from day 0, the last one ongoing, every citation a heading its note has', () => {
    for (const p of PROTOCOLS) {
      expect(p.stages[0]?.from, p.id).toBe(0)
      p.stages.forEach((s, i) => {
        const next = p.stages[i + 1]
        if (next) expect(s.to, `${p.id} ${s.id}`).toBe(next.from - 1)
        else expect(s, `${p.id} ends in maintenance`).toMatchObject({ id: 'maintenance', to: null })
        expect(s.light).toBe('unchanged')
        for (const c of [s.citation, s.feed.citation, ...s.checks.map(x => x.citation)]) {
          const headings = readFileSync(`${ROOT}${c.note}`, 'utf8').split('\n').filter(l => /^#{1,6} /.test(l)).map(l => l.replace(/^#+ /, '').trim())
          expect(headings, `${c.note} has "${c.section}"`).toContain(c.section)
        }
      })
    }
    // The doses and numbers the stages quote are the notes' own.
    const food = readFileSync(`${ROOT}knowledge/nutrients/gardyn-feeding-guidance.md`, 'utf8')
    for (const dose of ['1/4 tsp per gallon', '1/2 tsp per gallon', '1 tsp per gallon']) expect(food).toContain(dose)
    const sprouting = readFileSync(`${ROOT}knowledge/plants/germination.md`, 'utf8')
    expect(sprouting).toContain('Some seeds take up to 21 days to sprout')
    expect(sprouting).toContain('Place yCovers only after thinning')
    expect(sprouting).toContain('Always remove the cardboard covers before germinating')
  })

  it('picks Fruiting for any planted fruiting crop, else Greens & herbs', () => {
    expect(protocolFor(['Basil', null, 'Kale']).id).toBe('greens-herbs')
    expect(protocolFor(['Basil', 'Red Cherry Tomato']).id).toBe('fruiting')
    expect(protocolFor([]).id).toBe('greens-herbs')
  })

  it('says what changes between stages in a sentence', () => {
    expect(stageDiff(stage('germination'), stage('seedlings'))).toBe('Watering goes from once a week to once a day, 15 → 10 min.')
    expect(stageDiff(stage('seedlings'), stage('young'))).toBe('Watering goes from once a day to twice a day, 10 → 6 min.')
    expect(stageDiff(stage('young'), stage('maintenance'))).toBe('Watering goes from twice a day to 3 times a day, 6 min each.')
    expect(stageDiff(stage('young'), stage('young'))).toBe('Watering stays the same.')
    expect(stageDiff(stage('young'), { ...stage('young'), water: 'mature', light: 'day-16h' })).toBe('Watering goes from twice a day to 3 times a day, 6 min each. Light goes to Long day · 16 h.')
    expect(stageDiff(stage('seedlings'), { ...stage('seedlings'), water: 'germination' })).toBe('Watering goes from once a day to once a week, 10 → 15 min.')
    expect(stageDiff(stage('maintenance'), { ...stage('maintenance'), water: 'fruiting', light: 'nope' })).toBe('Watering goes from 3 times a day to 5 times a day, 6 → 5 min.')
  })

  it('fixes the track once germination ends, so a fruiting crop planted later doesn\'t switch it', () => {
    const store = tower()
    expect(protocolState(readTower(store), day(3)).protocol.id).toBe('greens-herbs')
    expect(runProtocol(store, day(8)).followed).toMatchObject({ from: 'germination', to: 'seedlings' })
    expect(store.grow.current()?.protocolId).toBe('greens-herbs')
    store.pods.update(2, { plant: 'Red Cherry Tomato', plantedAt: '2026-11-17', status: 'seeded' }, '2026-11-17T12:00:00Z')
    expect(protocolState(readTower(store), day(9)).protocol.id).toBe('greens-herbs')
    // Before germination ends it still goes by the crops.
    const early = tower()
    early.pods.update(2, { plant: 'Red Cherry Tomato', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
    expect(protocolState(readTower(early), day(3)).protocol.id).toBe('fruiting')
    expect(runProtocol(early, day(8)).followed).toMatchObject({ to: 'fruiting' })
  })

  it('reports where the protocol is: stage dates on the unit\'s calendar, the change into each, the water\'s owner', () => {
    const store = tower()
    const r = protocolReport(store, day(2))
    expect(r).toMatchObject({ following: true, protocol: { id: 'greens-herbs', name: 'Greens & herbs', fixed: false }, sownOn: '2026-11-09', day: 2, stage: 'germination', dayInStage: 2, canAdvance: true, hold: null, water: 'preset', activeScheduleId: 'preset:germination' })
    expect(r.stages.map(s => [s.id, s.startsOn, s.state])).toEqual([['germination', '2026-11-09', 'current'], ['seedlings', '2026-11-17', 'next'], ['young', '2026-11-23', 'next'], ['maintenance', '2026-12-01', 'next']])
    expect(r.stages[1]).toMatchObject({ change: 'Watering goes from once a week to once a day, 15 → 10 min.', water: { presetId: 'seedlings', runs: [480], durationS: 600, days: 127, weekly: false }, light: null })
    expect(r.stages[0]?.water).toMatchObject({ days: 1, weekly: true })
    expect(r.then).toEqual({ kind: 'stay', scheduleId: null, scheduleName: null, harvestDay: 60, harvestOn: '2027-01-08', done: false })
    expect(protocolReport(tower({ cycles: 'hand' }), day(2)).water).toBe('edited')
    expect(protocolReport(tower({ cycles: 'none' }), day(2))).toMatchObject({ water: 'none', activeScheduleId: null })
    // Nothing planted: no stage, nothing to advance.
    const empty = new MemoryStore(30)
    expect(protocolReport(empty, day(2))).toMatchObject({ stage: null, day: null, canAdvance: false, sownOn: null, stages: [{ startsOn: null, state: 'next' }, {}, {}, {}] })
    expect(runProtocol(empty, day(2)).followed).toBeNull()
  })

  it('counts from the grow cycle and lists the pods sown after it, by how many days', () => {
    const store = tower()
    store.pods.update(4, { plant: 'Kale', plantedAt: '2026-11-15', status: 'seeded' }, '2026-11-15T12:00:00Z')
    store.pods.update(5, { plant: 'Kale', plantedAt: 'not a date', status: 'seeded' }, '2026-11-15T12:00:00Z')
    const r = protocolReport(store, day(8))
    expect(r.day).toBe(8)
    expect(r.behind).toEqual([{ slot: 4, plant: 'Kale', daysBehind: 6 }])
    // Kale's first harvest (1 month) six days late is still before basil's two months.
    expect(r.then.harvestDay).toBe(60)
    store.pods.update(4, { plant: 'Basil', plantedAt: '2026-11-15' }, '2026-11-15T12:00:00Z')
    expect(protocolReport(store, day(8)).then.harvestDay).toBe(66)
  })

  it('holds a stage while the clock runs, and on release resumes it, later stages the days held later', () => {
    const store = tower({ cycles: 'seedlings' })
    holdProtocol(store, day(9))
    holdProtocol(store, day(10))
    expect(store.grow.current()).toMatchObject({ holdStageId: 'seedlings', holdSince: day(9).toISOString() })
    // Day 16 would be young plants: held, the watering stays.
    expect(runProtocol(store, day(16)).followed).toBeNull()
    expect(pumps(store)).toEqual(['water-seedlings-0800'])
    const held = protocolReport(store, day(16))
    expect(held).toMatchObject({ stage: 'seedlings', day: 9, dayInStage: 1, hold: { stageId: 'seedlings', days: 7 } })
    expect(held.stages.map(s => s.startsOn)).toEqual(['2026-11-09', '2026-11-17', '2026-11-30', '2026-12-08'])
    releaseProtocol(store, day(16))
    releaseProtocol(store, day(16))
    expect(store.grow.current()).toMatchObject({ shiftDays: -7, holdStageId: null, holdSince: null })
    expect(protocolReport(store, day(16))).toMatchObject({ stage: 'seedlings', day: 9, hold: null })
    expect(runProtocol(store, day(20)).followed).toBeNull()
    expect(runProtocol(store, day(21)).followed).toMatchObject({ from: 'seedlings', to: 'young' })
  })

  it('advances to the next stage now, releasing a hold, and refuses past maintenance or without a cycle', () => {
    const store = tower()
    holdProtocol(store, day(2))
    expect(advanceProtocol(store, day(2)).id).toBe('seedlings')
    expect(store.grow.current()).toMatchObject({ shiftDays: 6, holdStageId: null, protocolId: 'greens-herbs' })
    expect(runProtocol(store, day(2)).followed).toMatchObject({ from: 'germination', to: 'seedlings', days: 2 })
    expect(pumps(store)).toEqual(['water-seedlings-0800'])
    advanceProtocol(store, day(2))
    advanceProtocol(store, day(2))
    expect(protocolReport(store, day(2))).toMatchObject({ stage: 'maintenance', canAdvance: false })
    expect(() => advanceProtocol(store, day(2))).toThrow(/last stage and ongoing/)
    expect(() => advanceProtocol(tower({ cycle: false }), day(2))).toThrow(/No grow cycle is open/)
    expect(() => holdProtocol(new MemoryStore(30), day(2))).toThrow(/No grow cycle is open/)
    const bare = new MemoryStore(30)
    bare.grow.start(day(0).toISOString())
    expect(() => holdProtocol(bare, day(2))).toThrow(/Nothing is planted/)
    expect(() => advanceProtocol(bare, day(2))).toThrow(/Nothing is planted/)
  })

  it('keeps the days begun stages ran when Advance and Release move the clock', () => {
    const store = tower()
    // Advance on day 2 (Wed 11 Nov), then hold seedlings 10 days.
    advanceProtocol(store, day(2))
    holdProtocol(store, day(2))
    releaseProtocol(store, day(12))
    expect(store.grow.current()).toMatchObject({ shiftDays: -4, stageStarts: { germination: '2026-11-09', seedlings: '2026-11-11' } })
    const r = protocolReport(store, day(12))
    expect(r).toMatchObject({ stage: 'seedlings', day: 8 })
    expect(r.stages.map(s => [s.id, s.startsOn, s.state])).toEqual([['germination', '2026-11-09', 'done'], ['seedlings', '2026-11-11', 'current'], ['young', '2026-11-27', 'next'], ['maintenance', '2026-12-05', 'next']])
    // A later Advance records the stage it starts and keeps the rest.
    advanceProtocol(store, day(13))
    expect(protocolReport(store, day(13)).stages.map(s => s.startsOn).slice(0, 3)).toEqual(['2026-11-09', '2026-11-11', '2026-11-22'])
    // Water put ahead of the clock: its stage began no later than today.
    const ahead = tower({ cycles: 'mature' })
    expect(protocolReport(ahead, day(3)).stages.at(-1)).toMatchObject({ state: 'current', startsOn: '2026-11-12' })
  })

  it('offers Advance only where the server takes it: an open cycle, something planted, a stage to go to', () => {
    expect(protocolReport(tower(), day(2)).canAdvance).toBe(true)
    expect(protocolReport(tower({ cycles: 'mature' }), day(30)).canAdvance).toBe(false)
    expect(protocolReport(tower({ cycle: false }), day(2)).canAdvance).toBe(false)
    // Held, then everything emptied: a stage is held but nothing is planted.
    const emptied = tower()
    holdProtocol(emptied, day(2))
    emptied.pods.update(1, { plant: null, plantedAt: null, status: 'empty' }, day(3).toISOString())
    const r = protocolReport(emptied, day(3))
    expect(r).toMatchObject({ stage: 'germination', daysSinceSowing: null, canAdvance: false })
    expect(() => advanceProtocol(emptied, day(3))).toThrow(/Nothing is planted/)
  })

  it('stays in maintenance by default: nothing fires once it is reached', () => {
    const store = tower({ cycles: 'young' })
    expect(runProtocol(store, day(22))).toMatchObject({ followed: { to: 'mature' }, notices: [] })
    expect(runProtocol(store, day(200))).toMatchObject({ followed: null, notices: [] })
    expect(pumps(store)).toEqual(['water-mature-0800', 'water-mature-1400', 'water-mature-2000'])
  })

  it('switches to the queued schedule when maintenance begins, once, and then leaves it be', () => {
    const store = tower({ cycles: 'young' })
    store.scheduleLibrary.upsert(summer, 't')
    expect(setProtocolThen(store, day(15), { kind: 'schedule', scheduleId: 'summer', when: 'maintenance' })).toBeNull()
    expect(protocolReport(store, day(15)).then).toMatchObject({ kind: 'schedule', scheduleId: 'summer', scheduleName: 'Summer', done: false })
    expect(runProtocol(store, day(21)).followed).toBeNull()
    const run = runProtocol(store, day(22))
    // The change names the schedule put on, not the stage's preset.
    expect(run.followed).toMatchObject({ from: 'young', to: null, schedule: { id: 'summer', name: 'Summer' }, days: 22 })
    expect(run.followed?.detail).toMatch(/^Watering switched to Summer: maintenance began on day 22, as you chose\./)
    expect(pumps(store)).toEqual(['water-own-summer-0700', 'water-own-summer-1200', 'water-own-summer-1700', 'water-own-summer-2000'])
    expect(store.scheduleLibrary.get('summer')?.lastUsedAt).toBe(day(22).toISOString())
    const r = protocolReport(store, day(23))
    expect(r).toMatchObject({ water: 'schedule', activeScheduleId: 'summer', stage: 'maintenance', then: { done: true } })
    expect(runProtocol(store, day(23))).toMatchObject({ followed: null, notices: [] })
    // The current stage's preset hands watering back to the protocol.
    activateEntry(store, libraryEntry(readTower(store), 'preset:mature', day(24)) ?? (null as never), day(24))
    expect(protocolReport(store, day(24))).toMatchObject({ water: 'preset', activeScheduleId: 'preset:mature' })
  })

  it('doesn\'t switch over cycles changed by hand: it says so in Needs you instead', () => {
    const store = tower({ cycles: 'hand' })
    store.scheduleLibrary.upsert(summer, 't')
    setProtocolThen(store, day(15), { kind: 'schedule', scheduleId: 'summer' })
    const run = runProtocol(store, day(22))
    expect(run.followed).toBeNull()
    expect(run.notices).toEqual([{ kind: THEN_ALERT, detail: expect.stringMatching(/watering didn't switch to Summer: the pump cycles were changed by hand\./) }])
    expect(pumps(store)).toEqual(['mine'])
    expect(runProtocol(store, day(23)).notices).toEqual([])
  })

  it('switches now when asked, or when queued in maintenance; refuses a schedule it doesn\'t have', () => {
    const store = tower({ cycles: 'seedlings' })
    store.scheduleLibrary.upsert(summer, 't')
    expect(setProtocolThen(store, day(10), { kind: 'schedule', scheduleId: 'summer', when: 'now' })).toBe('summer')
    expect(activeEntryId(readTower(store))).toBe('summer')
    expect(runProtocol(store, day(22)).followed).toBeNull()
    const late = tower({ cycles: 'mature' })
    late.scheduleLibrary.upsert(summer, 't')
    expect(setProtocolThen(late, day(30), { kind: 'schedule', scheduleId: 'summer' })).toBe('summer')
    expect(() => setProtocolThen(late, day(30), { kind: 'schedule', scheduleId: 'winter' })).toThrow(/No schedule winter/)
    expect(() => setProtocolThen(late, day(30), { kind: 'schedule' })).toThrow(/Pick one of Your schedules/)
    expect(setProtocolThen(late, day(30), { kind: 'stay' })).toBeNull()
    expect(late.grow.current()).toMatchObject({ thenKind: 'stay', thenScheduleId: null })
  })

  it('reminds at the crops\' first harvest from the catalog, once, and refuses with no catalog crop', () => {
    const store = tower({ cycles: 'mature' })
    setProtocolThen(store, day(25), { kind: 'remind' })
    expect(runProtocol(store, day(59)).notices).toEqual([])
    expect(runProtocol(store, day(60)).notices).toEqual([{ kind: HARVEST_ALERT, detail: expect.stringMatching(/^First harvest is about now, day 60 since sowing/) }])
    expect(protocolReport(store, day(61)).then).toMatchObject({ kind: 'remind', harvestDay: 60, done: true })
    expect(runProtocol(store, day(61)).notices).toEqual([])
    const unknown = tower({ plant: 'Zzyzx' })
    expect(() => setProtocolThen(unknown, day(2), { kind: 'remind' })).toThrow(/No planted crop is in the catalog/)
  })

  it('changes no watering with Follow the grow cycle off, but still reminds at first harvest', () => {
    const store = tower({ cycles: 'young' })
    store.scheduleLibrary.upsert(summer, 't')
    store.settings.update({ followGrowCycle: false })
    setProtocolThen(store, day(15), { kind: 'schedule', scheduleId: 'summer' })
    expect(runProtocol(store, day(30))).toEqual({ followed: null, notices: [] })
    expect(pumps(store)).toEqual(['water-young-0800', 'water-young-1600'])
    expect(protocolReport(store, day(30))).toMatchObject({ following: false, then: { done: false } })
    setProtocolThen(store, day(30), { kind: 'remind' })
    expect(runProtocol(store, day(60)).notices).toEqual([{ kind: HARVEST_ALERT, detail: expect.stringMatching(/^First harvest is about now, day 60/) }])
    expect(pumps(store)).toEqual(['water-young-0800', 'water-young-1600'])
  })

  it('queues a switch again after going back to the protocol, and fires the new one', () => {
    const store = tower({ cycles: 'young' })
    store.scheduleLibrary.upsert(summer, 't')
    expect(setProtocolThen(store, day(15), { kind: 'schedule', scheduleId: 'summer', when: 'now' })).toBe('summer')
    expect(protocolReport(store, day(15)).then.done).toBe(true)
    // Back to the protocol, then queue the same schedule for maintenance.
    activateEntry(store, libraryEntry(readTower(store), 'preset:young', day(16)) ?? (null as never), day(16))
    setProtocolThen(store, day(16), { kind: 'schedule', scheduleId: 'summer', when: 'maintenance' })
    expect(protocolReport(store, day(16)).then).toMatchObject({ kind: 'schedule', done: false })
    expect(runProtocol(store, day(22)).followed).toMatchObject({ schedule: { id: 'summer' } })
    expect(protocolReport(store, day(22))).toMatchObject({ water: 'schedule', then: { done: true } })
    // Choosing the reminder again after it fired doesn't repeat it.
    const r = tower({ cycles: 'mature' })
    setProtocolThen(r, day(25), { kind: 'remind' })
    runProtocol(r, day(60))
    setProtocolThen(r, day(61), { kind: 'remind' })
    expect(runProtocol(r, day(62)).notices).toEqual([])
  })

  it('says why a queued switch didn\'t happen: another schedule, or no cycles; not when it is already on', () => {
    const store = tower({ cycles: 'young' })
    store.scheduleLibrary.upsert(summer, 't')
    store.scheduleLibrary.upsert({ ...summer, id: 'away', name: 'Away', cycles: [{ minute: 480, durationS: 480, days: 127 }] }, 't')
    setProtocolThen(store, day(15), { kind: 'schedule', scheduleId: 'summer' })
    activateEntry(store, libraryEntry(readTower(store), 'away', day(16)) ?? (null as never), day(16))
    expect(runProtocol(store, day(22)).notices[0]?.detail).toMatch(/another of your schedules, Away, is on\./)
    const none = tower({ cycles: 'none' })
    none.scheduleLibrary.upsert(summer, 't')
    setProtocolThen(none, day(15), { kind: 'schedule', scheduleId: 'summer' })
    expect(runProtocol(none, day(22)).notices[0]?.detail).toMatch(/there are no pump cycles\./)
    const on = tower({ cycles: 'young' })
    on.scheduleLibrary.upsert(summer, 't')
    setProtocolThen(on, day(15), { kind: 'schedule', scheduleId: 'summer' })
    activateEntry(on, libraryEntry(readTower(on), 'summer', day(16)) ?? (null as never), day(16))
    expect(runProtocol(on, day(22)).notices).toEqual([])
  })

  it('counts any built-in preset as a preset, even the other track\'s, and switches over it', () => {
    // No grow cycle: the track follows the crops, so a tomato flips seedlings watering onto Fruiting.
    const store = tower({ cycle: false, cycles: 'seedlings' })
    store.pods.update(2, { plant: 'Red Cherry Tomato', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
    const r = protocolReport(store, day(10))
    expect(r).toMatchObject({ protocol: { id: 'fruiting' }, stage: 'maintenance', water: 'preset', activeScheduleId: 'preset:seedlings' })
    // Never onto the fruiting track from seedlings: the cycles stay.
    expect(runProtocol(store, day(10)).followed).toBeNull()
    expect(pumps(store)).toEqual(['water-seedlings-0800'])
    // A grow cycle on it: a queued switch goes over the other track's preset too.
    const cycle = tower({ cycles: 'seedlings' })
    cycle.scheduleLibrary.upsert(summer, 't')
    cycle.pods.update(2, { plant: 'Red Cherry Tomato', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
    setProtocolThen(cycle, day(3), { kind: 'schedule', scheduleId: 'summer' })
    expect(runProtocol(cycle, day(8)).followed).toMatchObject({ from: 'seedlings', schedule: { id: 'summer' } })
  })
})

describe('your schedules (ADR-0030)', () => {
  it('activates one: its cycles replace the pump\'s, its light preset turns the other curves off; active is what the pump runs', () => {
    const store = tower({ cycles: 'mature' })
    store.schedules.upsert({ ...light, id: 'evening', name: 'Evening', enabled: false })
    store.scheduleLibrary.upsert({ ...summer, id: 'away', name: 'Away', cycles: [{ minute: 480, durationS: 480, days: 127 }], lightPresetId: 'day-14h' }, 't')
    const away = libraryEntry(readTower(store), 'away', day(30))
    if (!away) throw new Error('no away')
    activateEntry(store, away, day(30))
    expect(pumps(store)).toEqual(['water-own-away-0800'])
    expect(store.schedules.list().find(s => s.id === 'water-own-away-0800')).toMatchObject({ name: 'Away · 8 min (08:00)', enabled: true, days: 127, spec: { minute: 480, durationS: 480 } })
    const lights = () => store.schedules.list().filter(s => s.kind === 'light').map(s => [s.id, s.enabled]).sort()
    expect(lights()).toEqual([['evening', false], ['gardyn', false], ['light-own-away', true]])
    expect(activeEntryId(readTower(store))).toBe('away')
    // Another schedule with a light takes the place of this one's curve.
    store.scheduleLibrary.upsert({ ...summer, lightPresetId: 'day-16h' }, 't')
    activateEntry(store, libraryEntry(readTower(store), 'summer', day(31)) ?? (null as never), day(31))
    expect(lights()).toEqual([['evening', false], ['gardyn', false], ['light-own-summer', true]])
    // A cycle paused by hand is no longer the schedule as written.
    const first = store.schedules.list().find(s => s.id === 'water-own-summer-0700')
    if (first) store.schedules.upsert({ ...first, enabled: false })
    expect(activeEntryId(readTower(store))).toBeNull()
    expect(protocolReport(store, day(31)).water).toBe('edited')
  })

  it('turns back on exactly the curves a schedule\'s light turned off when one without a light is used', () => {
    const store = tower({ cycles: 'mature' })
    store.schedules.upsert({ ...light, id: 'evening', name: 'Evening', enabled: false })
    store.scheduleLibrary.upsert({ ...summer, id: 'away', name: 'Away', lightPresetId: 'day-14h' }, 't')
    store.scheduleLibrary.upsert(summer, 't')
    const use = (id: string) => activateEntry(store, libraryEntry(readTower(store), id, day(30)) ?? (null as never), day(30))
    const lights = () => store.schedules.list().filter(s => s.kind === 'light').map(s => [s.id, s.enabled]).sort()
    use('away')
    expect(store.settings.get().libraryLightsOff).toEqual(['gardyn'])
    // A preset has no light: the schedule's curve goes, and only the one it turned off comes back.
    use('preset:mature')
    expect(lights()).toEqual([['evening', false], ['gardyn', true]])
    expect(store.settings.get().libraryLightsOff).toBeNull()
    use('away')
    use('summer')
    expect(lights()).toEqual([['evening', false], ['gardyn', true]])
    // A curve deleted while it was off just stays gone.
    use('away')
    store.schedules.remove('gardyn')
    use('summer')
    expect(lights()).toEqual([['evening', false]])
  })

  it('takes the light off when the active schedule\'s light preset is cleared', async () => {
    const store = tower({ cycles: 'mature' })
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, events: createEventBus(), version: 'test', now: () => day(30) })
    const c = createCallerFactory(appRouter)(core.ctx)
    const away = await c.schedules.library.create({ name: 'Away', cycles: summer.cycles, lightPresetId: 'day-16h' })
    await c.schedules.library.activate({ id: away.id })
    expect(store.schedules.list().filter(s => s.kind === 'light' && s.enabled).map(s => s.id)).toEqual(['light-own-away'])
    await c.schedules.library.update({ id: away.id, lightPresetId: null })
    expect(store.schedules.list().filter(s => s.kind === 'light').map(s => [s.id, s.enabled])).toEqual([['gardyn', true]])
  })

  it('lists yours then the presets read-only, and keeps them through the API: create, update, delete, activate', async () => {
    const store = tower({ cycles: 'mature' })
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, events: createEventBus(), version: 'test', now: () => day(30) })
    const c = createCallerFactory(appRouter)(core.ctx)
    const before = await c.schedules.library.list()
    expect(before.map(e => [e.id, e.active, e.readOnly])).toEqual([['preset:germination', false, true], ['preset:seedlings', false, true], ['preset:young', false, true], ['preset:mature', true, true], ['preset:fruiting', false, true]])
    expect(before.find(e => e.id === 'preset:fruiting')?.cycles.map(x => x.minute)).toEqual([360, 600, 840, 1080])
    const made = await c.schedules.library.create({ name: 'Summer', cycles: summer.cycles })
    expect(made).toMatchObject({ id: 'summer', kind: 'own', active: false, lightPresetId: null })
    expect((await c.schedules.library.create({ name: 'Summer', cycles: summer.cycles })).id).toBe('summer-2')
    expect((await c.schedules.library.create({ name: '☀︎', cycles: summer.cycles })).id).toBe('schedule')
    await expect(c.schedules.library.create({ name: 'Twice', cycles: [{ minute: 480, durationS: 300, days: 127 }, { minute: 480, durationS: 60, days: 127 }] })).rejects.toThrow(/same minute/)
    await expect(c.schedules.library.create({ name: 'Dim', cycles: summer.cycles, lightPresetId: 'day-20h' })).rejects.toThrow(/not a light preset/)
    expect((await c.schedules.library.activate({ id: 'summer' })).find(e => e.id === 'summer')?.active).toBe(true)
    await expect(c.schedules.library.activate({ id: 'winter' })).rejects.toThrow(/no schedule winter/)
    // Editing the active schedule changes the pump with it; another one, only the library.
    expect(await c.schedules.library.update({ id: 'summer', cycles: [{ minute: 540, durationS: 360, days: 127 }] })).toMatchObject({ active: true, name: 'Summer' })
    expect(pumps(store)).toEqual(['water-own-summer-0900'])
    expect(await c.schedules.library.update({ id: 'summer-2', name: 'Late summer', lightPresetId: 'day-14h' })).toMatchObject({ name: 'Late summer', active: false, lightPresetId: 'day-14h' })
    expect(pumps(store)).toEqual(['water-own-summer-0900'])
    // summer-2's cycles are summer-2's, though their ids start like summer's.
    expect((await c.schedules.library.activate({ id: 'summer-2' })).filter(e => e.active).map(e => e.id)).toEqual(['summer-2'])
    await c.schedules.library.activate({ id: 'summer' })
    await expect(c.schedules.library.update({ id: 'preset:mature', name: 'Mine' })).rejects.toThrow(/read-only/)
    await expect(c.schedules.library.update({ id: 'nope', name: 'Mine' })).rejects.toThrow(/no schedule nope/)
    // Deleting the Then schedule puts Then back to staying in maintenance.
    store.grow.setProtocol({ thenKind: 'schedule', thenScheduleId: 'summer-2' })
    expect(await c.schedules.library.delete({ id: 'summer-2' })).toEqual({ removed: true })
    expect(store.grow.current()).toMatchObject({ thenKind: 'stay', thenScheduleId: null })
    expect(await c.schedules.library.delete({ id: 'summer' })).toEqual({ removed: true })
    expect(pumps(store)).toEqual(['water-own-summer-0900'])
    await expect(c.schedules.library.delete({ id: 'preset:young' })).rejects.toThrow(/read-only/)
  })
})

describe('the protocol over the API, MCP and the care engine', () => {
  function core(o: Parameters<typeof tower>[0] = {}, at = 2) {
    const store = tower(o)
    const events = createEventBus()
    const c = createCore({ hal: new SimHal({ tickMs: 0 }), store, events, version: 'test', now: () => day(at) })
    return { store, events, core: c, caller: createCallerFactory(appRouter)(c.ctx) }
  }

  it('holds, releases, advances and sets Then through tRPC, refusing what it can\'t do as a bad request', async () => {
    const { caller, store } = core({}, 2)
    expect(await caller.protocol.current()).toMatchObject({ stage: 'germination', day: 2 })
    expect(await caller.protocol.hold()).toMatchObject({ hold: { stageId: 'germination', days: 0 } })
    expect(await caller.protocol.release()).toMatchObject({ hold: null })
    expect(await caller.protocol.advance()).toMatchObject({ stage: 'seedlings', day: 8 })
    store.scheduleLibrary.upsert(summer, 't')
    expect(await caller.protocol.setThen({ kind: 'schedule', scheduleId: 'summer', when: 'now' })).toMatchObject({ water: 'schedule', activeScheduleId: 'summer', then: { kind: 'schedule', done: true } })
    expect(await caller.protocol.setThen({ kind: 'stay', when: 'maintenance' })).toMatchObject({ then: { kind: 'stay' } })
    await expect(caller.protocol.setThen({ kind: 'schedule', when: 'maintenance' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    store.grow.end(day(2).toISOString())
    await expect(caller.protocol.hold()).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/No grow cycle is open/) })
  })

  it('reads and steers it over MCP', async () => {
    const { core: c, store } = core({ cycles: 'mature' }, 30)
    store.scheduleLibrary.upsert(summer, 't')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(c.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const body = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]?.text ?? '')
    expect(await body('grow_protocol')).toMatchObject({ protocol: { id: 'greens-herbs' }, stage: 'maintenance', canAdvance: false })
    expect((await body('list_schedule_library')).map((e: { id: string }) => e.id)).toEqual(['summer', 'preset:germination', 'preset:seedlings', 'preset:young', 'preset:mature', 'preset:fruiting'])
    expect(await body('hold_protocol', { action: 'hold' })).toMatchObject({ hold: { stageId: 'maintenance' } })
    expect(await body('hold_protocol', { action: 'release' })).toMatchObject({ hold: null })
    expect(await body('set_protocol_then', { kind: 'remind' })).toMatchObject({ then: { kind: 'remind', harvestDay: 60 } })
    expect((await client.callTool({ name: 'advance_protocol', arguments: {} })).isError).toBe(true)
    expect((await body('activate_schedule', { id: 'summer' })).find((e: { id: string }) => e.id === 'summer')).toMatchObject({ active: true })
    expect(await body('set_protocol_then', { kind: 'schedule', schedule_id: 'summer' })).toMatchObject({ then: { kind: 'schedule', scheduleId: 'summer' } })
    await client.close()
  })

  it('raises the protocol\'s notices as alerts, and reruns when the grow cycle changes', () => {
    const store = tower({ cycles: 'mature' })
    const events = createEventBus()
    let now = day(30)
    const engine = new CareEngine({ store, hal: new SimHal({ tickMs: 0 }), events, now: () => now })
    setProtocolThen(store, now, { kind: 'remind' })
    engine.start()
    expect(store.alerts.list().some(a => a.kind === HARVEST_ALERT)).toBe(false)
    now = day(61)
    events.emit({ kind: 'mutation', path: 'grow' })
    expect(store.alerts.list().find(a => a.kind === HARVEST_ALERT && a.active)?.detail).toMatch(/^First harvest is about now, day 61/)
    engine.stop()
  })
})
