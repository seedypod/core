/**
 * Grow protocols (ADR-0030): one sequence of stages a grow runs, each setting
 * water, light, feed and checks, ending in an ongoing maintenance stage. The
 * runner moves the pump cycles on to each stage's preset as the protocol day
 * comes, forward only and only over cycles still exactly as a preset wrote
 * them (src/care/follow.ts). Hold pins a stage and Advance skips to the next;
 * both move the clock, never the stages. What comes after maintenance is a
 * person's choice (stay, a schedule of theirs, or a reminder at first
 * harvest), never a date. Off with Settings → followGrowCycle.
 */
import { LIGHT_PRESETS } from '../scheduler/lightPlan'
import type { Catalog } from '../plants/catalog'
import { advances, dayNumber, daysSinceSowing, plantCategories, presetDays, presetRuns, PUMP_PRESETS, sowDate, type PumpPreset, type PumpPresetId } from '../scheduler/pumpPlan'
import { localTime } from '../scheduler/time'
import type { GrowCycle, SavedSchedule, Store, ThenKind } from '../store/types'
import { followedPreset, keepSowingWeekday, moveWatering, pumpCycles, todaysLight, type FollowChange } from './follow'
import { CITE, type Citation } from './knowledge'
import { activateEntry, activeEntryId, activeOwn, libraryEntry } from './library'
import { readTower, towerSowWeekday, type Tower } from './tower'

export type ProtocolId = 'greens-herbs' | 'fruiting'
export type StageId = 'germination' | 'seedlings' | 'young' | 'maintenance'

export interface CitedText { text: string, citation: Citation }

export interface ProtocolStage {
  id: StageId
  name: string
  /** Protocol days, inclusive; the last stage's `to` is null: ongoing. */
  from: number
  to: number | null
  water: PumpPresetId
  /** A light preset id, or `unchanged` to leave the curves alone. */
  light: string
  feed: CitedText
  checks: CitedText[]
  rationale: string
  citation: Citation
}

export interface Protocol { id: ProtocolId, name: string, stages: readonly ProtocolStage[] }

/** The needs-you items the runner raises: a queued switch that couldn't happen, and the first-harvest reminder. */
export const THEN_ALERT = 'reminder_schedule_switch'
export const HARVEST_ALERT = 'reminder_first_harvest'

const preset = (id: PumpPresetId) => PUMP_PRESETS.find(p => p.id === id) as PumpPreset
const checks = {
  covers: { text: 'Take the cardboard covers off before germinating.', citation: CITE.germinationStart },
  sprouts: { text: 'Check the yCubes daily for sprouts; some take up to 21 days.', citation: CITE.sprouting },
  thin: { text: 'Thin each pod to its strongest sprout, and put yCovers on only after thinning.', citation: CITE.yCovers },
  roots: { text: 'Check the roots: dry and brittle wants more water, pooled water before a cycle wants less.', citation: CITE.roots },
  tank: { text: 'Keep the tank at least half full.', citation: CITE.tankHalfFull },
  cadence: { text: 'Top off weekly with water and plant food; refresh at least every 4 weeks.', citation: CITE.tankCadence },
} satisfies Record<string, CitedText>

const germination: ProtocolStage = {
  id: 'germination', name: 'Germination', from: 0, to: 7, water: 'germination', light: 'unchanged',
  feed: { text: 'Plain water: no plant food until the sprouts come up.', citation: CITE.plantFood },
  checks: [checks.covers, checks.sprouts],
  rationale: 'Gardyn’s germination mode: a 15 min cycle on the sowing day and day 7.',
  citation: preset('germination').citation,
}

export const PROTOCOLS: readonly Protocol[] = [
  {
    id: 'greens-herbs',
    name: 'Greens & herbs',
    stages: [
      germination,
      {
        id: 'seedlings', name: 'Seedlings', from: 8, to: 13, water: 'seedlings', light: 'unchanged',
        feed: { text: 'The sprout dose, 1/4 tsp per gallon, once most yCubes have sprouted.', citation: CITE.plantFood },
        checks: [checks.sprouts, checks.thin],
        rationale: 'Once a day while the first leaves open.',
        citation: preset('seedlings').citation,
      },
      {
        id: 'young', name: 'Young plants', from: 14, to: 21, water: 'young', light: 'unchanged',
        feed: { text: '1/2 tsp per gallon at the weekly top-off, for true leaves and early growth.', citation: CITE.plantFood },
        checks: [checks.roots, checks.tank, checks.cadence],
        rationale: 'More often as the roots grow.',
        citation: preset('young').citation,
      },
      {
        id: 'maintenance', name: 'Maintenance', from: 22, to: null, water: 'mature', light: 'unchanged',
        feed: { text: '1 tsp per gallon at the weekly top-off.', citation: CITE.plantFood },
        checks: [checks.roots, checks.tank, checks.cadence],
        rationale: 'Mature greens and herbs, spread across the light hours, for as long as they grow.',
        citation: preset('mature').citation,
      },
    ],
  },
  {
    id: 'fruiting',
    name: 'Fruiting',
    stages: [
      germination,
      {
        id: 'maintenance', name: 'Maintenance', from: 8, to: null, water: 'fruiting', light: 'unchanged',
        feed: { text: 'The sprout dose, 1/4 tsp per gallon, once most yCubes have sprouted; then 1 tsp per gallon at the weekly top-off as they mature and fruit.', citation: CITE.plantFood },
        checks: [checks.thin, checks.roots, checks.tank, checks.cadence],
        rationale: 'Fruiting crops go from germination straight to their own watering.',
        citation: preset('fruiting').citation,
      },
    ],
  },
]

export const findProtocol = (id: string | null | undefined) => PROTOCOLS.find(p => p.id === id) ?? null

/** One protocol for the tower, by the planted crops: any fruiting crop picks Fruiting, a custom one included when `catalog` has it. */
export function protocolFor(plants: ReadonlyArray<string | null>, catalog?: Pick<Catalog, 'find'>): Protocol {
  const categories = catalog ? plants.flatMap(p => (p ? catalog.find(p)?.category ?? [] : [])) : plantCategories(plants)
  return (categories.includes('fruiting') ? PROTOCOLS[1] : PROTOCOLS[0]) as Protocol
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** Whose watering the pump runs: a built-in preset as written (either track's), one of Your schedules, cycles changed by hand, or none. */
export type WaterState = 'preset' | 'schedule' | 'edited' | 'none'

export interface ProtocolState {
  protocol: Protocol
  cycle: GrowCycle | null
  /** The sowing date on the unit's calendar: the grow cycle's start, else the earliest pod. */
  sownOn: string | null
  daysSinceSowing: number | null
  /** Days since sowing plus the shift, frozen while held. */
  day: number | null
  /** Where the protocol is: the held stage, else the later of the clock's and the one whose water is on the pump. */
  stage: ProtocolStage | null
  /** Whole days held so far. */
  heldDays: number
  water: WaterState
  /** The built-in preset the pump cycles are, as written, on either track. */
  applied: PumpPreset | null
  /** This protocol's stage for that preset; null when it belongs to the other track. */
  waterStage: ProtocolStage | null
  /** The saved schedule the pump cycles are, as written. */
  own: SavedSchedule | null
  /** The crops' first harvest in days since sowing, from the catalog, the latest across pods; null with no catalog crop. */
  harvestDay: number | null
  /** Pods sown after the protocol's sowing date, by how many days. */
  behind: Array<{ slot: number, plant: string | null, daysBehind: number }>
}

/** Where the tower's protocol is now. */
export function protocolState(t: Tower, now: Date): ProtocolState {
  const tz = t.settings.timezone
  const { cycle, planted: pods } = t
  const protocol = findProtocol(cycle?.protocolId) ?? protocolFor(pods.map(p => p.plant), t.catalog)
  const sownOn = sowDate(cycle?.startedAt, pods.map(p => p.plantedAt), tz)
  // An open cycle counts from its start, pods planted or not, so germination started today reads as day 0.
  const days = cycle || pods.length ? daysSinceSowing(cycle?.startedAt, pods.map(p => p.plantedAt), now, tz) : null
  const today = localTime(now, tz).date
  const heldDays = cycle?.holdSince ? Math.max(0, dayNumber(today) - dayNumber(localTime(new Date(cycle.holdSince), tz).date)) : 0
  const day = days === null ? null : Math.max(0, days + (cycle?.shiftDays ?? 0) - heldDays)
  const clock = day === null ? null : protocol.stages.filter(s => s.from <= day).at(-1) ?? null
  const held = cycle?.holdStageId ? protocol.stages.find(s => s.id === cycle.holdStageId) ?? null : null

  const live = pumpCycles(t.schedules)
  const applied = followedPreset(live)
  const waterStage = applied ? protocol.stages.find(s => s.water === applied.id) ?? null : null
  const own = applied ? null : activeOwn(t)
  const water: WaterState = applied ? 'preset' : own ? 'schedule' : live.length ? 'edited' : 'none'
  const index = (s: ProtocolStage | null) => (s ? protocol.stages.indexOf(s) : -1)
  const later = index(waterStage) > index(clock) ? waterStage : clock
  const stage = held ?? (day === null ? null : later)

  const behind = pods.flatMap((p) => {
    const at = p.plantedAt && Number.isFinite(Date.parse(p.plantedAt)) ? sowDate(p.plantedAt, [], tz) : null
    const by = at && sownOn ? dayNumber(at) - dayNumber(sownOn) : 0
    return by > 0 ? [{ slot: p.slot, plant: p.plant, daysBehind: by }] : []
  })
  const harvests = pods.flatMap((p) => {
    const months = p.plant ? t.catalog.find(p.plant)?.harvestMonths[0] : undefined
    return months === undefined ? [] : [months * 30 + (behind.find(b => b.slot === p.slot)?.daysBehind ?? 0)]
  })
  const harvestDay = harvests.length ? Math.max(...harvests) : null
  return { protocol, cycle, sownOn, daysSinceSowing: days, day, stage, heldDays, water, applied, waterStage, own, harvestDay, behind }
}

/** What the runner did on a tick: the watering move, if any, and the needs-you items it raised. */
export interface ProtocolRun {
  followed: FollowChange | null
  notices: Array<{ kind: string, detail: string }>
}

/**
 * One tick of the protocol. The first-harvest reminder fires whatever
 * followGrowCycle says, as it changes no watering. With it on: fix the track
 * once germination ends, carry out a switch queued for maintenance, move the
 * watering on to the stage's preset if it's still a preset and that's a step
 * forward, and keep germination's run on the sowing weekday. Each Then fires
 * once. Writes only on a change.
 */
export function runProtocol(store: Store, now: Date): ProtocolRun {
  const t = readTower(store)
  const st = protocolState(t, now)
  const { protocol, cycle, stage, daysSinceSowing: days } = st
  const run: ProtocolRun = { followed: null, notices: [] }
  if (!stage || days === null) return run
  // A Then's needs-you item is written before Then is marked done, so one that fails to write is tried again next tick.
  const notify = (kind: string, detail: string) => {
    store.alerts.raise(kind, detail, now.toISOString())
    run.notices.push({ kind, detail })
  }
  if (cycle?.thenKind === 'remind' && !cycle.thenDoneAt && st.harvestDay !== null && days >= st.harvestDay) {
    notify(HARVEST_ALERT, `First harvest is about now, day ${days} since sowing, by the catalog. Watering stays on ${protocol.name} maintenance; choose what comes after in the Then slot on Grow if you want a change.`)
    store.grow.setProtocol({ thenDoneAt: now.toISOString() })
  }
  // Watering moves only for a tower with something planted, as Follow always did.
  if (!t.settings.followGrowCycle || !t.planted.length) return run
  // The track is fixed once its watering is past germination, recognised here or moved on below, so a crop planted later doesn't switch it.
  const fix = (s: ProtocolStage | null) => {
    if (cycle && cycle.protocolId === null && s && protocol.stages.indexOf(s) > 0) store.grow.setProtocol({ protocolId: protocol.id })
  }
  fix(st.waterStage)

  // A switch queued for maintenance replaces a preset's watering when maintenance begins, once; marked done only once it's written.
  if (stage === protocol.stages.at(-1) && cycle?.thenKind === 'schedule' && cycle.thenScheduleId && !cycle.thenDoneAt) {
    const entry = libraryEntry(t, cycle.thenScheduleId, now)
    if (entry && st.applied) {
      activateEntry(store, entry, now)
      store.grow.setProtocol({ thenDoneAt: now.toISOString() })
      run.followed = { from: st.applied.id, to: null, schedule: { id: entry.id, name: entry.name }, days, detail: `Watering switched to ${entry.name}: maintenance began on day ${days}, as you chose. Back to ${preset(stage.water).name} on Grow hands watering back to the protocol.` }
      return run
    }
    if (entry && st.own?.id !== entry.id) {
      const why = st.own ? `another of your schedules, ${st.own.name}, is on` : st.water === 'none' ? 'there are no pump cycles' : 'the pump cycles were changed by hand'
      notify(THEN_ALERT, `Maintenance began on day ${days}, but watering didn't switch to ${entry.name}: ${why}. Choose it again in the Then slot on Grow to switch now.`)
    }
    store.grow.setProtocol({ thenDoneAt: now.toISOString() })
  }
  const water = st.waterStage
  if (!water) return run
  const cycles = pumpCycles(t.schedules)
  const sowDay = towerSowWeekday(t, now)
  if (water.id === 'germination' && stage.id === 'germination') {
    run.followed = keepSowingWeekday(store, cycles, sowDay, days)
    return run
  }
  if (!advances(water.water, stage.water)) return run
  run.followed = moveWatering(store, { cycles, from: water.water, to: preset(stage.water), days, sowDay, light: todaysLight(t.schedules, now, t.settings.timezone) })
  fix(stage)
  return run
}

/** A stage's watering as the pump would run it: run times, length and day mask. */
export function stageWater(stage: ProtocolStage, light: { on: number, off: number } | null, weekday: number) {
  const p = preset(stage.water)
  return { presetId: p.id, name: p.name, runs: presetRuns(p, light), durationS: p.durationS, days: presetDays(p, weekday), weekly: !!p.weekly }
}

const often = (w: { runs: number[], weekly: boolean }) => {
  const n = w.runs.length
  if (w.weekly) return n === 1 ? 'once a week' : `${n} times a week`
  return n === 1 ? 'once a day' : n === 2 ? 'twice a day' : `${n} times a day`
}

/**
 * What changes between two stages, in a sentence: "Watering goes from once a
 * week to once a day, 15 → 10 min." Light is named only when a stage sets it.
 */
export function stageDiff(from: ProtocolStage, to: ProtocolStage, light: { on: number, off: number } | null = null): string {
  const a = stageWater(from, light, 0)
  const b = stageWater(to, light, 0)
  const [fa, fb] = [often(a), often(b)]
  const [ma, mb] = [Math.round(a.durationS / 60), Math.round(b.durationS / 60)]
  const length = ma === mb ? `${mb} min each` : `${ma} → ${mb} min`
  let water = fa === fb ? `Watering stays ${fb}, ${length}.` : `Watering goes from ${fa} to ${fb}, ${length}.`
  if (fa === fb && ma === mb && a.runs.join() === b.runs.join()) water = 'Watering stays the same.'
  if (to.light === 'unchanged' || to.light === from.light) return water
  const curve = LIGHT_PRESETS.find(p => p.id === to.light)
  return curve ? `${water} Light goes to ${curve.name}.` : water
}

/**
 * The day each stage began or begins. Stages already begun keep the day
 * recorded for them when the clock last moved, else the day the current clock
 * gives (never after today); later ones follow the clock, after any hold.
 */
function stageStarts(st: ProtocolState, today: string): Array<string | null> {
  const { protocol, cycle, stage, sownOn } = st
  const current = stage ? protocol.stages.indexOf(stage) : -1
  return protocol.stages.map((s, i) => {
    if (sownOn === null) return null
    if (i <= current) {
      const at = cycle?.stageStarts[s.id] ?? addDays(sownOn, s.from - (cycle?.shiftDays ?? 0))
      return at > today ? today : at
    }
    return addDays(sownOn, s.from - (cycle?.shiftDays ?? 0) + st.heldDays)
  })
}

/** The begun stages' days as the clock has them now, to record before Advance or Release moves it. */
function begun(st: ProtocolState, today: string): Record<string, string> {
  const starts = stageStarts(st, today)
  const current = st.stage ? st.protocol.stages.indexOf(st.stage) : -1
  return Object.fromEntries(st.protocol.stages.flatMap((s, i) => {
    const at = starts[i]
    return i <= current && at ? [[s.id, at]] : []
  }))
}

/** The protocol for the Grow page and MCP: every stage resolved, with its dates on the unit's calendar. */
export function protocolReport(store: Store, now: Date) {
  const t = readTower(store)
  const st = protocolState(t, now)
  const { protocol, cycle, stage, day } = st
  const light = todaysLight(t.schedules, now, t.settings.timezone)
  const weekday = towerSowWeekday(t, now)
  const current = stage ? protocol.stages.indexOf(stage) : -1
  const starts = stageStarts(st, localTime(now, t.settings.timezone).date)
  const stages = protocol.stages.map((s, i) => {
    const prev = protocol.stages[i - 1]
    const lightPreset = LIGHT_PRESETS.find(p => p.id === s.light)
    return {
      id: s.id,
      name: s.name,
      from: s.from,
      to: s.to,
      startsOn: starts[i] ?? null,
      state: current < 0 ? 'next' as const : i < current ? 'done' as const : i === current ? 'current' as const : 'next' as const,
      water: { ...stageWater(s, light, weekday), citation: preset(s.water).citation },
      light: lightPreset ? { presetId: lightPreset.id, name: lightPreset.name } : null,
      feed: s.feed,
      checks: s.checks,
      rationale: s.rationale,
      citation: s.citation,
      change: prev ? stageDiff(prev, s, light) : null,
    }
  })
  const scheduleId = cycle?.thenKind === 'schedule' ? cycle.thenScheduleId : null
  const then = {
    kind: (cycle?.thenKind ?? 'stay') as ThenKind,
    scheduleId,
    scheduleName: scheduleId ? libraryEntry(t, scheduleId, now)?.name ?? null : null,
    harvestDay: st.harvestDay,
    harvestOn: st.harvestDay === null || st.sownOn === null ? null : addDays(st.sownOn, st.harvestDay),
    done: !!cycle?.thenDoneAt,
  }
  return {
    following: t.settings.followGrowCycle,
    protocol: { id: protocol.id, name: protocol.name, fixed: !!cycle?.protocolId },
    cycleId: cycle?.id ?? null,
    sownOn: st.sownOn,
    daysSinceSowing: st.daysSinceSowing,
    day,
    stage: stage?.id ?? null,
    dayInStage: stage && day !== null ? Math.max(0, day - stage.from) : null,
    // Only what advanceProtocol would do: an open cycle, something planted, a stage after this one.
    canAdvance: !!cycle && st.daysSinceSowing !== null && current >= 0 && current < protocol.stages.length - 1,
    hold: cycle?.holdStageId ? { stageId: cycle.holdStageId, since: cycle.holdSince, days: st.heldDays } : null,
    then,
    water: st.water,
    activeScheduleId: activeEntryId(t),
    stages,
    behind: st.behind,
  }
}

export type ProtocolReport = ReturnType<typeof protocolReport>

/** Why a protocol action can't happen, for the API to refuse it with. */
export class ProtocolError extends Error {}

function openState(store: Store, now: Date): ProtocolState & { cycle: GrowCycle, today: string } {
  const t = readTower(store)
  if (!t.cycle) throw new ProtocolError('No grow cycle is open: start one on Grow first.')
  return { ...protocolState(t, now), cycle: t.cycle, today: localTime(now, t.settings.timezone).date }
}

/** Pin the current stage: the clock stops for it until Release. */
export function holdProtocol(store: Store, now: Date): void {
  const st = openState(store, now)
  if (st.cycle.holdStageId) return
  if (!st.stage) throw new ProtocolError('No sowing day yet, so there is no stage to hold.')
  store.grow.setProtocol({ holdStageId: st.stage.id, holdSince: now.toISOString() })
}

/** Let the clock run again from where it was held: later stages start the days held later; begun ones keep their days. */
export function releaseProtocol(store: Store, now: Date): void {
  const st = openState(store, now)
  if (!st.cycle.holdStageId) return
  store.grow.setProtocol({ shiftDays: st.cycle.shiftDays - st.heldDays, holdStageId: null, holdSince: null, stageStarts: { ...begun(st, st.today), ...st.cycle.stageStarts } })
}

/** Skip to the next stage now, releasing any hold; maintenance has none. Begun stages keep their days. */
export function advanceProtocol(store: Store, now: Date): ProtocolStage {
  const st = openState(store, now)
  const { protocol, stage, daysSinceSowing: days, cycle } = st
  if (!stage || days === null) throw new ProtocolError('No sowing day yet, so there is no stage to advance from.')
  const next = protocol.stages[protocol.stages.indexOf(stage) + 1]
  if (!next) throw new ProtocolError(`${stage.name} is the last stage and ongoing: there is nothing to advance to.`)
  const stageStarts = { ...begun(st, st.today), ...cycle.stageStarts, [next.id]: st.today }
  store.grow.setProtocol({ shiftDays: next.from - days, holdStageId: null, holdSince: null, stageStarts, ...(cycle.protocolId ? {} : { protocolId: protocol.id }) })
  return next
}

/**
 * Choose what comes after: stay in maintenance; switch to a schedule now, or
 * when maintenance begins (now, if it already has); or a reminder at first
 * harvest. A new choice can fire again; choosing the reminder again doesn't
 * repeat one that fired. Returns the schedule it switched to now, if it did.
 */
export function setProtocolThen(store: Store, now: Date, then: { kind: ThenKind, scheduleId?: string | null, when?: 'now' | 'maintenance' }): string | null {
  const st = openState(store, now)
  if (then.kind === 'stay') {
    store.grow.setProtocol({ thenKind: 'stay', thenScheduleId: null, thenDoneAt: null })
    return null
  }
  if (then.kind === 'remind') {
    if (st.harvestDay === null) throw new ProtocolError('No planted crop is in the catalog, so there is no first-harvest day to remind on.')
    store.grow.setProtocol({ thenKind: 'remind', thenScheduleId: null, thenDoneAt: st.cycle.thenKind === 'remind' ? st.cycle.thenDoneAt : null })
    return null
  }
  const entry = then.scheduleId ? libraryEntry(readTower(store), then.scheduleId, now) : null
  if (!entry) throw new ProtocolError(then.scheduleId ? `No schedule ${then.scheduleId} in Your schedules.` : 'Pick one of Your schedules to switch to.')
  // What comes after the protocol is one of yours; the built-in presets are the protocol's own stages.
  if (entry.kind !== 'own') throw new ProtocolError(`${entry.name} is one of the protocol's presets: pick one of your own schedules to switch to.`)
  const inMaintenance = st.stage !== null && st.stage === st.protocol.stages.at(-1)
  const nowToo = then.when === 'now' || inMaintenance
  if (nowToo) activateEntry(store, entry, now)
  store.grow.setProtocol({ thenKind: 'schedule', thenScheduleId: entry.id, thenDoneAt: nowToo ? now.toISOString() : null })
  return nowToo ? entry.id : null
}
