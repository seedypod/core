/**
 * Chores (ADR-0029): thin, trim roots, top off, refresh, feed and clean. Each
 * comes from a reading where the unit has one it can trust (the tank level and
 * how fast it falls, an EC probe, the camera's leaf cover on young pods), and
 * otherwise from a calendar, which it says is a guess and why. A reading
 * counts only when its quality is good and it is under 15 minutes old: a top-off
 * is never advised from a suspect tank level. Doses and targets come from
 * `knowledge.ts` with their citations. Read-only: logging a tank action of the
 * chore's kind is what marks it done.
 */
import type { Reading, SensorId } from '../hardware/contract'
import type { HalSnapshot } from '../hardware/types'
import { findPlant } from '../plants/catalog'
import type { Pod, Store, TankActionKind } from '../store/types'
import { CITE, type Citation, type CropGroup, EC_TARGETS, FRUITING_FOR_FAST_REFRESH, REFRESH_DAYS, REFRESH_FRUITING_DAYS, SPROUT_DOSE_DAYS, TANK_MIN_PCT, TOP_OFF_DAYS } from './knowledge'

export const CHORE_IDS = ['thin', 'trim_roots', 'top_off', 'refresh', 'feed', 'clean'] as const
export type ChoreId = typeof CHORE_IDS[number]
export type ChoreState = 'due' | 'soon' | 'ok' | 'unknown'

export interface ChoreReading { sensor: SensorId, value: number, unit: string, quality: Reading['quality'], ts: string }

export interface Chore {
  id: ChoreId
  title: string
  state: ChoreState
  /** `reading`: from a sensor the unit trusts right now. `timeline`: a calendar guess, and the reason says why. */
  basis: 'reading' | 'timeline'
  reason: string
  /** When it falls due, on the calendar or projected from a reading; null when neither says. */
  dueAt: string | null
  /** The last logged tank action that counts as doing it. */
  lastDoneAt: string | null
  /** The readings it was derived from; empty on a timeline. */
  readings: ChoreReading[]
  /** Where every dose and target in the reason comes from. */
  citations: Citation[]
  /** Log a tank action of this kind to mark it done. */
  doneKind: TankActionKind
}

const DAY_MS = 86_400_000
/** As the Status page: older than this, a reading is stale. */
export const READING_MAX_AGE_MS = 15 * 60_000
/** Leaf cover on a pod's camera crop that means something has come up. */
export const SPROUT_COVER = 0.02
/** Photos older than this say nothing about a sprout today. */
const PHOTO_MAX_AGE_MS = 2 * DAY_MS
/** Pods planted longer ago than this are past thinning. */
const THIN_WINDOW_DAYS = 35
/** Gardyn publishes no cleaning interval; every third refresh is seedypod's guess. */
export const CLEAN_DAYS = 3 * REFRESH_DAYS
/** A rise this big between samples is a top-up (as the Water page's chart). */
const TOP_UP_PCT = 8
/** "Soon" is within this many days of due, on a calendar or a projection. */
const SOON_DAYS = 2
/** After a logged top-off or feed, how long the reading gets to catch up before it is believed again. */
export const SETTLE_MS = 60 * 60_000

const LABEL: Partial<Record<SensorId, string>> = { water_level_pct: 'tank level', ec: 'EC', ph: 'pH' }
const DONE_LABEL: Record<TankActionKind, string> = { feed: 'feed', top_off: 'top-off', refresh: 'refresh', ph_down: 'pH Down', ph_up: 'pH Up', clean: 'clean', trim_roots: 'root trim', thin: 'thinning', other: 'action' }
const TITLE: Record<ChoreId, string> = { thin: 'Thin seedlings', trim_roots: 'Check and trim roots', top_off: 'Top off the tank', refresh: 'Refresh the tank', feed: 'Feed', clean: 'Clean the tank' }

const round1 = (v: number) => Math.round(v * 10) / 10
const days = (v: number) => `${Math.max(0, Math.floor(v))} d`
const iso = (t: number) => new Date(t).toISOString()

/** A reading the advice may use, or why it may not. */
export function trusted(snap: HalSnapshot, id: SensorId, now: Date): { reading: Reading | null, why: string | null } {
  const label = LABEL[id] ?? id
  const r = snap.sensors[id]
  if (!snap.online) return { reading: null, why: `${label} unknown while the hardware daemon is offline` }
  if (!snap.system?.caps.sensors.includes(id) && !r) return { reading: null, why: id === 'water_level_pct' ? 'no tank level sensor' : `no ${label} probe` }
  if (!r) return { reading: null, why: `${label} not reporting` }
  if (r.quality === 'suspect') return { reading: null, why: `${label} reading suspect` }
  const age = now.getTime() - Date.parse(r.ts)
  if (r.quality === 'stale' || age > READING_MAX_AGE_MS) return { reading: null, why: `${label} reading stale` }
  return { reading: r, why: null }
}

const asReading = (sensor: SensorId, r: Reading): ChoreReading => ({ sensor, value: r.value, unit: r.unit, quality: r.quality, ts: r.ts })

/** The last logged action of any of these kinds. */
function lastDone(store: Store, kinds: TankActionKind[]): { at: number, kind: TankActionKind } | null {
  let best: { at: number, kind: TankActionKind } | null = null
  for (const kind of kinds) {
    const a = store.tankActions.list({ kind, limit: 1 })[0]
    if (a && (!best || Date.parse(a.ts) > best.at)) best = { at: Date.parse(a.ts), kind }
  }
  return best
}

/** What a calendar counts from: the last time it was done, else the cycle start, else the first planting. */
function anchor(store: Store, kinds: TankActionKind[], planted: Pod[]): { at: number, what: string } | null {
  const done = lastDone(store, kinds)
  if (done) return { at: done.at, what: `the last ${DONE_LABEL[done.kind]}` }
  const cycle = store.grow.current()
  if (cycle) return { at: Date.parse(cycle.startedAt), what: 'the grow cycle started' }
  const first = planted.map(p => (p.plantedAt ? Date.parse(p.plantedAt) : Number.NaN)).filter(t => !Number.isNaN(t)).sort((a, b) => a - b)[0]
  return first === undefined ? null : { at: first, what: 'the first pod was planted' }
}

/** A calendar chore: due `every` days after its anchor. */
function onCalendar(c: Omit<Chore, 'state' | 'basis' | 'dueAt' | 'readings' | 'reason'>, o: { every: number, from: { at: number, what: string } | null, now: Date, why: string, rule: string, none: string }): Chore {
  const base = { ...c, basis: 'timeline' as const, readings: [] }
  if (!o.from) return { ...base, state: 'unknown', dueAt: null, reason: `${o.why}: ${o.none}` }
  const since = (o.now.getTime() - o.from.at) / DAY_MS
  const state: ChoreState = since >= o.every ? 'due' : since >= o.every - SOON_DAYS ? 'soon' : 'ok'
  return { ...base, state, dueAt: iso(o.from.at + o.every * DAY_MS), reason: `${o.why}: ${days(since)} since ${o.from.what}. ${o.rule}` }
}

/** % a day the tank is falling since its last top-up, over up to 3 days; null without enough to go on. */
export function tankDropPerDay(store: Store, now: Date): number | null {
  const pts = store.telemetry.range('water_level_pct', iso(now.getTime() - 3 * DAY_MS), now.toISOString(), 500)
    .map(p => ({ t: Date.parse(p.ts) / DAY_MS, v: p.value }))
    .sort((a, b) => a.t - b.t)
  let start = 0
  for (let i = 1; i < pts.length; i++) {
    if ((pts[i]?.v ?? 0) - (pts[i - 1]?.v ?? 0) >= TOP_UP_PCT) start = i
  }
  const seg = pts.slice(start)
  if (seg.length < 6 || (seg.at(-1)?.t ?? 0) - (seg[0]?.t ?? 0) < 0.5) return null
  const mt = seg.reduce((s, p) => s + p.t, 0) / seg.length
  const mv = seg.reduce((s, p) => s + p.v, 0) / seg.length
  let num = 0
  let den = 0
  for (const p of seg) {
    num += (p.t - mt) * (p.v - mv)
    den += (p.t - mt) ** 2
  }
  const slope = num / den
  return slope < 0 ? round1(-slope) : 0
}

/** Which EC band the tower is fed to: seedlings early in a cycle, else what most of it is. */
export function cropGroup(store: Store, planted: Pod[]): { group: CropGroup, fruiting: number } {
  const cats = planted.map(p => (p.plant ? findPlant(p.plant)?.category : undefined)).filter(c => c !== undefined)
  const fruiting = cats.filter(c => c === 'fruiting').length
  const stage = store.grow.current()?.stage
  if (stage === 'germination' || stage === 'seedling') return { group: 'seedlings', fruiting }
  if (cats.length && fruiting * 2 >= cats.length) return { group: 'fruiting crops', fruiting }
  if (cats.length && cats.every(c => c === 'herb')) return { group: 'herbs', fruiting }
  return { group: 'leafy greens', fruiting }
}

/** A reading still says due just after it was done: give the tank time to mix before saying so again. */
function settle(c: Chore, done: { at: number, kind: TankActionKind } | null, now: Date): Chore {
  const ago = done ? now.getTime() - done.at : Number.POSITIVE_INFINITY
  if (!done || ago < 0 || ago > SETTLE_MS) return c
  return { ...c, state: 'ok', dueAt: null, reason: `${c.reason.split(':')[0]}, but a ${DONE_LABEL[done.kind]} was logged ${Math.max(1, Math.round(ago / 60_000))} min ago: waiting for the reading to settle.` }
}

function topOff(store: Store, snap: HalSnapshot, now: Date, planted: Pod[]): Chore {
  const kinds: TankActionKind[] = ['top_off', 'refresh']
  const done = lastDone(store, kinds)
  const c = { id: 'top_off' as const, title: TITLE.top_off, lastDoneAt: done ? iso(done.at) : null, doneKind: 'top_off' as const }
  const { reading, why } = trusted(snap, 'water_level_pct', now)
  if (!reading) {
    return onCalendar({ ...c, citations: [CITE.tankCadence] }, { every: TOP_OFF_DAYS, from: anchor(store, kinds, planted), now, why: `Calendar guess, ${why}`, rule: `Gardyn tops off every ${TOP_OFF_DAYS} d.`, none: 'nothing logged or planted to count from.' })
  }
  const level = reading.value
  const drop = tankDropPerDay(store, now)
  const falling = drop ? `, falling ${drop}% a day` : ''
  const base = { ...c, basis: 'reading' as const, readings: [asReading('water_level_pct', reading)], citations: [CITE.tankHalfFull] }
  if (level < TANK_MIN_PCT) return settle({ ...base, state: 'due', dueAt: now.toISOString(), reason: `Tank at ${Math.round(level)}%${falling}: below half, so top it off. Keep it at least half full.` }, done, now)
  const toHalf = drop ? (level - TANK_MIN_PCT) / drop : null
  if (toHalf !== null && toHalf <= SOON_DAYS) return { ...base, state: 'soon', dueAt: iso(now.getTime() + toHalf * DAY_MS), reason: `Tank at ${Math.round(level)}%${falling}: below half in about ${round1(toHalf)} d.` }
  return { ...base, state: 'ok', dueAt: toHalf === null ? null : iso(now.getTime() + toHalf * DAY_MS), reason: `Tank at ${Math.round(level)}%${falling}${toHalf === null ? '' : `: half full in about ${Math.round(toHalf)} d`}.` }
}

function feed(store: Store, snap: HalSnapshot, now: Date, planted: Pod[]): Chore {
  const kinds: TankActionKind[] = ['feed', 'refresh']
  const done = lastDone(store, kinds)
  const c = { id: 'feed' as const, title: TITLE.feed, lastDoneAt: done ? iso(done.at) : null, doneKind: 'feed' as const }
  const { group } = cropGroup(store, planted)
  const { reading, why } = trusted(snap, 'ec', now)
  if (!reading) {
    const every = done ? store.settings.get().nutrientReminderDays || TOP_OFF_DAYS : SPROUT_DOSE_DAYS
    const rule = done
      ? `Gardyn adds plant food with the weekly top-off: 1/2 tsp per gallon of Gardyn Plant Food in early growth, 1 tsp once mature. Other products dose differently.`
      : `The first feed, Gardyn's sprout dose of 1/4 tsp Gardyn Plant Food per gallon, goes in once most yCubes have sprouted, usually within ${SPROUT_DOSE_DAYS} d.`
    return onCalendar({ ...c, citations: [CITE.plantFood, CITE.dosesByProduct] }, { every, from: anchor(store, kinds, planted), now, why: `Calendar guess, ${why}`, rule, none: 'nothing logged or planted to count from.' })
  }
  const raw = reading.value
  const ec = round1(raw)
  const t = EC_TARGETS[group]
  const band = `${t.min.toFixed(1)}–${t.max.toFixed(1)} mS/cm for ${group}`
  const base = { ...c, basis: 'reading' as const, dueAt: null, readings: [asReading('ec', reading)], citations: [CITE.phEc, CITE.dosesByProduct] }
  if (raw < t.min) return settle({ ...base, state: 'due', dueAt: now.toISOString(), reason: `EC ${ec} mS/cm, below the ${band}: feed until it reads about ${t.min}. Dose to the reading; teaspoons differ between products.` }, done, now)
  if (raw > t.max) return { ...base, state: 'ok', reason: `EC ${ec} mS/cm, above the ${band}: don't feed. Topping off with plain water brings it down.` }
  if (raw < t.min + 0.1) return { ...base, state: 'soon', reason: `EC ${ec} mS/cm, at the low end of the ${band}: feed in the next few days.` }
  return { ...base, state: 'ok', reason: `EC ${ec} mS/cm, within the ${band}.` }
}

function refresh(store: Store, now: Date, planted: Pod[]): Chore {
  const done = lastDone(store, ['refresh'])
  const { fruiting } = cropGroup(store, planted)
  const every = fruiting >= FRUITING_FOR_FAST_REFRESH ? REFRESH_FRUITING_DAYS : REFRESH_DAYS
  const rule = every === REFRESH_FRUITING_DAYS
    ? `Gardyn refreshes every ${every} d with ${FRUITING_FOR_FAST_REFRESH} or more fruiting plants (${fruiting} here), and sooner on yellowing leaves or leaf-edge burn.`
    : `Gardyn refreshes at least every ${every} d, and sooner on yellowing leaves or leaf-edge burn.`
  return onCalendar({ id: 'refresh', title: TITLE.refresh, lastDoneAt: done ? iso(done.at) : null, doneKind: 'refresh', citations: [CITE.tankCadence] }, { every, from: anchor(store, ['refresh'], planted), now, why: 'Calendar, as no reading measures it', rule, none: 'nothing logged or planted to count from.' })
}

function clean(store: Store, now: Date, planted: Pod[]): Chore {
  const done = lastDone(store, ['clean'])
  return onCalendar({ id: 'clean', title: TITLE.clean, lastDoneAt: done ? iso(done.at) : null, doneKind: 'clean', citations: [CITE.tankCadence] }, { every: CLEAN_DAYS, from: anchor(store, ['clean'], planted), now, why: 'Calendar guess, as Gardyn publishes no cleaning interval', rule: `seedypod suggests a deep clean every third refresh (${CLEAN_DAYS} d).`, none: 'nothing logged or planted to count from.' })
}

function trimRoots(store: Store, now: Date, planted: Pod[]): Chore {
  const done = lastDone(store, ['trim_roots'])
  const c = { id: 'trim_roots' as const, title: TITLE.trim_roots, lastDoneAt: done ? iso(done.at) : null, doneKind: 'trim_roots' as const, citations: [] }
  const every = store.settings.get().rootCheckReminderDays
  if (every <= 0) return { ...c, state: 'ok', basis: 'timeline', dueAt: null, readings: [], reason: 'Root checks are off in Settings → Grow reminders.' }
  return onCalendar(c, { every, from: anchor(store, ['trim_roots'], planted), now, why: 'Calendar guess, as no sensor sees the roots', rule: `Check them every ${every} d (Settings → Grow reminders) and trim any reaching the pump.`, none: 'nothing logged or planted to count from.' })
}

function thin(store: Store, now: Date, planted: Pod[]): Chore {
  const done = lastDone(store, ['thin'])
  const c = { id: 'thin' as const, title: TITLE.thin, lastDoneAt: done ? iso(done.at) : null, doneKind: 'thin' as const, citations: [CITE.plantFood] }
  const t = now.getTime()
  const young = planted.filter((p) => {
    const at = p.plantedAt ? Date.parse(p.plantedAt) : Number.NaN
    return (p.status === 'seeded' || p.status === 'growing') && !Number.isNaN(at) && t - at <= THIN_WINDOW_DAYS * DAY_MS && (!done || done.at < at)
  })
  if (!young.length) return { ...c, state: 'ok', basis: 'timeline', dueAt: null, readings: [], reason: done ? 'Thinned since the youngest pods were planted.' : `No pods planted in the last ${THIN_WINDOW_DAYS} d to thin.` }
  // The camera: the primary analyser's latest leaf cover for each young pod, since it was planted.
  const analyzer = store.settings.get().primaryAnalyzer
  const covers = young.flatMap((p) => {
    const last = store.analyses.series({ analyzer, slot: p.slot, metric: 'green_fraction', limit: 1 }).at(-1)
    const fresh = last && Date.parse(last.ts) > Date.parse(p.plantedAt ?? '') && t - Date.parse(last.ts) <= PHOTO_MAX_AGE_MS
    return fresh ? [last.value] : []
  })
  if (covers.length && covers.length * 2 >= young.length) {
    const up = covers.filter(v => v >= SPROUT_COVER).length
    const of = `${up} of ${covers.length} young pods`
    const base = { ...c, basis: 'reading' as const, dueAt: null, readings: [] }
    if (up * 4 >= covers.length * 3) return { ...base, state: 'due', dueAt: now.toISOString(), reason: `${of} show leaves on camera, so most have sprouted: thin each pod to its strongest sprout.` }
    if (up > 0) return { ...base, state: 'soon', reason: `${of} show leaves on camera; thin once most have sprouted.` }
    return { ...base, state: 'ok', reason: `No leaves on camera yet in ${covers.length} young pods.` }
  }
  const every = store.settings.get().thinningReminderDays || SPROUT_DOSE_DAYS
  const oldest = Math.min(...young.map(p => Date.parse(p.plantedAt ?? '')))
  return onCalendar(c, { every, from: { at: oldest, what: 'the oldest young pod was planted' }, now, why: `Calendar guess, ${covers.length ? 'too few recent photos of the young pods' : 'no recent photos of the young pods'}`, rule: `yCubes usually sprout within ${SPROUT_DOSE_DAYS} d; thin about ${every} d after planting.`, none: '' })
}

/** Every chore for the unit as it is now, in a fixed order. */
export function chores(store: Store, snap: HalSnapshot, now: Date): Chore[] {
  const planted = store.pods.list().filter(p => p.status !== 'empty')
  const all = [thin(store, now, planted), trimRoots(store, now, planted), topOff(store, snap, now, planted), refresh(store, now, planted), feed(store, snap, now, planted), clean(store, now, planted)]
  // An empty tower needs no feeding or topping off; cleaning between grows still counts.
  return planted.length ? all : all.map(c => (c.id === 'clean' ? c : { ...c, state: 'ok', dueAt: null, reason: 'Nothing planted.' }))
}
