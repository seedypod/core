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
import { catalogFor } from '../plants/custom'
import { LIGHT_PRESETS } from '../scheduler/lightPlan'
import { advances, daysSinceSowing, plantCategories, presetRuns, PUMP_PRESETS, sowDate, sowWeekday, type PumpPreset, type PumpPresetId } from '../scheduler/pumpPlan'
import { localTime } from '../scheduler/time'
import type { GrowCycle, PumpSpec, Schedule, Store, ThenKind } from '../store/types'
import { followedPreset, keepSowingWeekday, moveWatering, todaysLight, type FollowChange } from './follow'
import { CITE, type Citation } from './knowledge'
import { activateEntry, activeEntryId, activeOwn, libraryEntry } from './library'

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

/** The alerts the runner raises: a queued switch that couldn't happen, and the first-harvest reminder. */
export const THEN_ALERT = 'protocol_then'
export const HARVEST_ALERT = 'protocol_harvest'
/** Keys in the grow cycle's `issued` list, so each Then fires once per cycle. */
const SWITCHED = 'protocol_then'
const REMINDED = 'protocol_harvest'

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

/** One protocol for the tower, by the planted crops: any fruiting crop picks Fruiting. */
export function protocolFor(plants: ReadonlyArray<string | null>): Protocol {
  return (plantCategories(plants).includes('fruiting') ? PROTOCOLS[1] : PROTOCOLS[0]) as Protocol
}

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const planted = (store: Store) => store.pods.list().filter(p => p.status !== 'empty')
const pumps = (schedules: readonly Schedule[]) => schedules.filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')

export type WaterState = 'protocol' | 'schedule' | 'edited' | 'none'

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
  /** The protocol stage whose preset the pump cycles are, as written. */
  waterStage: ProtocolStage | null
  /** The crops' first harvest in days since sowing, from the catalog, the latest across pods; null with no catalog crop. */
  harvestDay: number | null
  /** Pods sown after the protocol's sowing date, by how many days. */
  behind: Array<{ slot: number, plant: string | null, daysBehind: number }>
}

/** Where the tower's protocol is now. */
export function protocolState(store: Store, now: Date): ProtocolState {
  const settings = store.settings.get()
  const tz = settings.timezone
  const pods = planted(store)
  const cycle = store.grow.current()
  const protocol = findProtocol(cycle?.protocolId) ?? protocolFor(pods.map(p => p.plant))
  const sownOn = sowDate(cycle?.startedAt, pods.map(p => p.plantedAt), tz)
  const days = pods.length ? daysSinceSowing(cycle?.startedAt, pods.map(p => p.plantedAt), now, tz) : null
  const today = localTime(now, tz).date
  const heldDays = cycle?.holdSince ? Math.max(0, dayNumber(today) - dayNumber(localTime(new Date(cycle.holdSince), tz).date)) : 0
  const day = days === null ? null : Math.max(0, days + (cycle?.shiftDays ?? 0) - heldDays)
  const clock = day === null ? null : protocol.stages.filter(s => s.from <= day).at(-1) ?? null
  const held = cycle?.holdStageId ? protocol.stages.find(s => s.id === cycle.holdStageId) ?? null : null

  const live = pumps(store.schedules.list())
  const applied = followedPreset(live)
  const waterStage = applied ? protocol.stages.find(s => s.water === applied.id) ?? null : null
  const water: WaterState = waterStage ? 'protocol' : activeOwn(store) ? 'schedule' : live.length ? 'edited' : 'none'
  const index = (s: ProtocolStage | null) => (s ? protocol.stages.indexOf(s) : -1)
  const later = index(waterStage) > index(clock) ? waterStage : clock
  const stage = held ?? (day === null ? null : later)

  const catalog = catalogFor(store)
  const behind = pods.flatMap((p) => {
    const at = p.plantedAt && Number.isFinite(Date.parse(p.plantedAt)) ? sowDate(p.plantedAt, [], tz) : null
    const by = at && sownOn ? dayNumber(at) - dayNumber(sownOn) : 0
    return by > 0 ? [{ slot: p.slot, plant: p.plant, daysBehind: by }] : []
  })
  const harvests = pods.flatMap((p) => {
    const months = p.plant ? catalog.find(p.plant)?.harvestMonths[0] : undefined
    return months === undefined ? [] : [months * 30 + (behind.find(b => b.slot === p.slot)?.daysBehind ?? 0)]
  })
  const harvestDay = harvests.length ? Math.max(...harvests) : null
  return { protocol, cycle, sownOn, daysSinceSowing: days, day, stage, heldDays, water, waterStage, harvestDay, behind }
}

/** What the runner did on a tick: the watering move and any Then notice. */
export interface ProtocolRun {
  followed: FollowChange | null
  /** The saved schedule a queued switch put on, if one did. */
  switched: string | null
  notices: Array<{ kind: string, detail: string }>
}

const NOTHING: ProtocolRun = { followed: null, switched: null, notices: [] }

/**
 * One tick of the protocol: move the watering on to the stage's preset if
 * it's still the protocol's and that's a step forward, keep germination's run
 * on the sowing weekday, fix the protocol once germination ends, and carry out
 * the Then that was chosen, each once. Writes only on a change.
 */
export function runProtocol(store: Store, now: Date): ProtocolRun {
  const settings = store.settings.get()
  if (!settings.followGrowCycle) return NOTHING
  const st = protocolState(store, now)
  const { protocol, cycle, stage, daysSinceSowing: days } = st
  if (!stage || days === null) return NOTHING
  // Past germination the track is fixed, so a crop planted later doesn't switch it.
  if (cycle && cycle.protocolId === null && protocol.stages.indexOf(stage) > 0) store.grow.setProtocol({ protocolId: protocol.id })
  const notices: ProtocolRun['notices'] = []
  const run = { followed: null as FollowChange | null, switched: null as string | null, notices }

  const last = protocol.stages.at(-1)
  if (cycle?.thenKind === 'remind' && st.harvestDay !== null && days >= st.harvestDay && !cycle.issued.includes(REMINDED)) {
    store.grow.markIssued(REMINDED)
    notices.push({ kind: HARVEST_ALERT, detail: `First harvest is about now, day ${days} since sowing, by the catalog. Watering stays on ${protocol.name} maintenance; switch to one of your schedules on Grow if you want a change.` })
  }

  const water = st.waterStage
  // A switch queued for maintenance replaces the protocol's watering when maintenance begins, once.
  if (stage === last && cycle?.thenKind === 'schedule' && cycle.thenScheduleId && !cycle.issued.includes(SWITCHED)) {
    store.grow.markIssued(SWITCHED)
    const entry = libraryEntry(store, cycle.thenScheduleId, now)
    if (entry && water) {
      activateEntry(store, entry, now)
      run.switched = entry.id
      run.followed = { from: water.water, to: stage.water, days, detail: `Maintenance began on day ${days}: watering switched to your schedule ${entry.name}, as chosen. Use ${preset(stage.water).name} from Your schedules on Grow to go back to the protocol.` }
      return run
    }
    if (entry && activeEntryId(store) !== entry.id) notices.push({ kind: THEN_ALERT, detail: `Maintenance began on day ${days}, but watering didn't switch to ${entry.name}: the pump cycles were changed since the protocol set them. Use it from Your schedules on Grow to switch now.` })
  }
  if (!water) return run
  const pods = planted(store)
  const cycles = pumps(store.schedules.list())
  const sowDay = sowWeekday(cycle?.startedAt, pods.map(p => p.plantedAt), settings.timezone, now)
  if (water.id === 'germination' && stage.id === 'germination') {
    run.followed = keepSowingWeekday(store, cycles, sowDay, days)
    return run
  }
  if (!advances(water.water, stage.water)) return run
  run.followed = moveWatering(store, now, { cycles, from: water.water, to: preset(stage.water), days, sowDay })
  return run
}

/** The protocol's watering move, as the care engine and the follow tests see it. */
export function followGrowCycle(store: Store, now: Date): FollowChange | null {
  return runProtocol(store, now).followed
}

/** A stage's watering as the pump would run it: run times, length and day mask. */
export function stageWater(stage: ProtocolStage, light: { on: number, off: number } | null, weekday: number) {
  const p = preset(stage.water)
  return { presetId: p.id, name: p.name, runs: presetRuns(p, light), durationS: p.durationS, days: p.weekly ? 1 << weekday : 127, weekly: !!p.weekly }
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

/** The protocol for the Grow page and MCP: every stage resolved, with its dates on the unit's calendar. */
export function protocolReport(store: Store, now: Date) {
  const settings = store.settings.get()
  const st = protocolState(store, now)
  const { protocol, cycle, stage, day } = st
  const light = todaysLight(store.schedules.list(), now, settings.timezone)
  const weekday = sowWeekday(cycle?.startedAt, planted(store).map(p => p.plantedAt), settings.timezone, now)
  const current = stage ? protocol.stages.indexOf(stage) : -1
  // Later stages start after the hold too; earlier ones keep the dates they ran on.
  const startsOn = (s: ProtocolStage, i: number) => (st.sownOn === null ? null : addDays(st.sownOn, s.from - (cycle?.shiftDays ?? 0) + (i > current ? st.heldDays : 0)))
  const stages = protocol.stages.map((s, i) => {
    const prev = protocol.stages[i - 1]
    const lightPreset = LIGHT_PRESETS.find(p => p.id === s.light)
    return {
      id: s.id,
      name: s.name,
      from: s.from,
      to: s.to,
      startsOn: startsOn(s, i),
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
    scheduleName: scheduleId ? libraryEntry(store, scheduleId, now)?.name ?? null : null,
    harvestDay: st.harvestDay,
    harvestOn: st.harvestDay === null || st.sownOn === null ? null : addDays(st.sownOn, st.harvestDay),
    done: !!cycle && (cycle.thenKind === 'schedule' ? cycle.issued.includes(SWITCHED) : cycle.thenKind === 'remind' && cycle.issued.includes(REMINDED)),
  }
  return {
    following: settings.followGrowCycle,
    protocol: { id: protocol.id, name: protocol.name, fixed: !!cycle?.protocolId },
    cycleId: cycle?.id ?? null,
    sownOn: st.sownOn,
    daysSinceSowing: st.daysSinceSowing,
    day,
    stage: stage?.id ?? null,
    dayInStage: stage && day !== null ? Math.max(0, day - stage.from) : null,
    canAdvance: !!cycle && current >= 0 && current < protocol.stages.length - 1,
    hold: cycle?.holdStageId ? { stageId: cycle.holdStageId, since: cycle.holdSince, days: st.heldDays } : null,
    then,
    water: st.water,
    activeScheduleId: activeEntryId(store),
    stages,
    behind: st.behind,
  }
}

export type ProtocolReport = ReturnType<typeof protocolReport>

/** Why a protocol action can't happen, for the API to refuse it with. */
export class ProtocolError extends Error {}

function openCycle(store: Store): GrowCycle {
  const c = store.grow.current()
  if (!c) throw new ProtocolError('No grow cycle is open: start one on Grow first.')
  return c
}

/** Pin the current stage: the clock stops for it until Release. */
export function holdProtocol(store: Store, now: Date): void {
  const c = openCycle(store)
  if (c.holdStageId) return
  const { stage } = protocolState(store, now)
  if (!stage) throw new ProtocolError('Nothing is planted, so there is no stage to hold.')
  store.grow.setProtocol({ holdStageId: stage.id, holdSince: now.toISOString() })
}

/** Let the clock run again from where it was held: later stages start the days held later. */
export function releaseProtocol(store: Store, now: Date): void {
  const c = openCycle(store)
  if (!c.holdStageId) return
  const { heldDays } = protocolState(store, now)
  store.grow.setProtocol({ shiftDays: c.shiftDays - heldDays, holdStageId: null, holdSince: null })
}

/** Skip to the next stage now, releasing any hold; maintenance has none. */
export function advanceProtocol(store: Store, now: Date): ProtocolStage {
  const c = openCycle(store)
  const { protocol, stage, daysSinceSowing: days } = protocolState(store, now)
  if (!stage || days === null) throw new ProtocolError('Nothing is planted, so there is no stage to advance from.')
  const next = protocol.stages[protocol.stages.indexOf(stage) + 1]
  if (!next) throw new ProtocolError(`${stage.name} is the last stage and ongoing: there is nothing to advance to.`)
  store.grow.setProtocol({ shiftDays: next.from - days, holdStageId: null, holdSince: null, ...(c.protocolId ? {} : { protocolId: protocol.id }) })
  return next
}

/**
 * Choose what comes after: stay in maintenance; switch to a schedule now, or
 * when maintenance begins (now, if it already has); or a reminder at first
 * harvest. Returns the schedule it switched to now, if it did.
 */
export function setProtocolThen(store: Store, now: Date, then: { kind: ThenKind, scheduleId?: string | null, when?: 'now' | 'maintenance' }): string | null {
  openCycle(store)
  const st = protocolState(store, now)
  if (then.kind === 'stay') {
    store.grow.setProtocol({ thenKind: 'stay', thenScheduleId: null })
    return null
  }
  if (then.kind === 'remind') {
    if (st.harvestDay === null) throw new ProtocolError('No planted crop is in the catalog, so there is no first-harvest day to remind on.')
    store.grow.setProtocol({ thenKind: 'remind', thenScheduleId: null })
    return null
  }
  const entry = then.scheduleId ? libraryEntry(store, then.scheduleId, now) : null
  if (!entry) throw new ProtocolError(then.scheduleId ? `No schedule ${then.scheduleId} in Your schedules.` : 'Pick one of Your schedules to switch to.')
  store.grow.setProtocol({ thenKind: 'schedule', thenScheduleId: entry.id })
  const inMaintenance = st.stage !== null && st.stage === st.protocol.stages.at(-1)
  if (then.when !== 'now' && !inMaintenance) return null
  store.grow.markIssued(SWITCHED)
  activateEntry(store, entry, now)
  return entry.id
}
