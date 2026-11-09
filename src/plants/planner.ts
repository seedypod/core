/**
 * Pod planner — clean-room implementation of Gardyn's published placement
 * rules (help.mygardyn.com/en/articles/11567361):
 *
 *  1. Each plant goes in its light zone (catalog `zone`).
 *  2. "If the ideal spot is unavailable, place your plants one light zone
 *     lower." Every plant gets its ideal zone before any plant falls back;
 *     a fallback is one zone lower, never two and never up, and is flagged.
 *     We never substitute a different plant (My Pod Planner does — see
 *     knowledge/evaluation/mypodplanner-crosscheck-2026-11-02.md).
 *  3. Cucumbers start in the bottom of the middle column so the vine grows
 *     into higher light (Gardyn's explicit exception).
 *  4. "Leave space between larger plants so they do not block light from
 *     smaller plants nearby": large plants are spread apart by an adjacency
 *     penalty when choosing among equally good slots.
 *
 * The caller can override 1–2 per plant (pin a pod to a slot, or allow other
 * zones). What does not fit comes back with the zones it could use, the pods
 * in them, and moves that would make room.
 *
 * Pure and deterministic; no clock, no I/O.
 */
import { BUILTIN, type Catalog, type Plant, SUCCESSION_GAP_DAYS, type Zone } from './catalog'
import { type Model, MODELS, type Slot, slots } from './zones'

const LOWER: Record<Zone, Zone | null> = { high: 'medium', medium: 'low', low: null }
const HIGHER: Record<Zone, Zone | null> = { high: null, medium: 'high', low: 'medium' }
const ZONE_RANK: Record<Zone, number> = { high: 0, medium: 1, low: 2 }
const ZONES: Zone[] = ['high', 'medium', 'low']
/**
 * Categories that take more light than their zone without harm, so a planner
 * may offer a higher zone when theirs is full. Not lettuces or leafy greens:
 * Gardyn warns too much light can hasten bolting; nor vegetables (brassicas bolt too).
 */
const TAKES_MORE_LIGHT: ReadonlySet<Plant['category']> = new Set(['herb', 'flower', 'legume'])

/** Caller overrides, honoured before the automatic rules. */
export interface PlanOverrides {
  /** Put one pod of `plantId` in this exact slot. Pins count toward that plant's requested count; extra pins add pods. */
  pins?: { slot: number, plantId: string }[]
  /** Zones a plant may use instead of Gardyn's ideal-or-one-lower: one zone only, or two zones lower. */
  allowedZones?: Record<string, Zone[]>
}

export interface PlanRequest {
  model: Model
  /** Plant ids with how many pods of each. */
  plants: { plantId: string, count: number }[]
  /** Slots already taken (existing pods): slot → plant id (or any truthy marker). */
  occupied?: Record<number, string>
  overrides?: PlanOverrides
}

export interface Assignment {
  slot: number
  row: number
  col: number
  slotZone: Zone | null
  plantId: string
  plantName: string
  wantZone: Zone
  /** Zones away from the ideal (0 = ideal). */
  fallback: number
  reason: string
}

/** How one light zone of the tower is used once the plan is laid out. */
export interface ZoneSummary {
  zone: Zone
  rows: number[]
  slots: number[]
  total: number
  /** Pods already planted. */
  existing: number
  /** Pods this plan places. */
  planned: number
  free: number
}

/** A pod in a zone an unplaced plant could have used. */
export interface Blocker {
  slot: number
  zone: Zone
  plantId: string
  plantName: string
  /** Already planted, not part of this plan. */
  existing: boolean
}

export interface Unplaced {
  plantId: string
  plantName: string
  reason: string
  code: 'not_in_catalog' | 'no_space' | 'bad_pin'
  wantZone: Zone | null
  /** Zones the planner was allowed to use for it, best first. */
  zones: Zone[]
  blocking: Blocker[]
}

export interface Suggestion {
  /** The plant that did not fit. */
  plantId: string
  plantName: string
  /**
   * relocate: move another pod to a slot it tolerates; allow_lower: let this plant go one zone further down than Gardyn's rule;
   * allow_higher: let a herb, flower or legume use a brighter zone with free pods.
   */
  kind: 'relocate' | 'allow_lower' | 'allow_higher'
  /** The slot the unplaced plant would take. */
  slot: number
  zone: Zone
  move: { plantId: string, plantName: string, from: number, to: number, toZone: Zone, existing: boolean } | null
  text: string
  /** Overrides that carry the suggestion out when passed back to the planner; null when a planted yCube has to be moved by hand first. */
  overrides: PlanOverrides | null
}

export interface PlanResult {
  model: Model
  assignments: Assignment[]
  unplaced: Unplaced[]
  free: number[]
  zones: ZoneSummary[]
  suggestions: Suggestion[]
  /** The overrides this layout was computed with, kept so a saved plan can be recomputed. */
  overrides?: PlanOverrides
}

/** Zones a plant may use, best first: its ideal zone, else one lower — or the caller's allowed zones. */
export function toleratedZones(plant: Plant, overrides?: PlanOverrides): Zone[] {
  const custom = overrides?.allowedZones?.[plant.id]
  if (custom?.length) {
    const d = (z: Zone) => Math.abs(ZONE_RANK[z] - ZONE_RANK[plant.zone])
    return [...new Set(custom)].sort((a, b) => d(a) - d(b) || ZONE_RANK[b] - ZONE_RANK[a])
  }
  const lower = LOWER[plant.zone]
  return lower ? [plant.zone, lower] : [plant.zone]
}

function neighbours(model: Model, s: Slot): Slot[] {
  const all = slots(model)
  return all.filter(o => (o.col === s.col && Math.abs(o.row - s.row) === 1) || (o.row === s.row && Math.abs(o.col - s.col) === 1))
}

/** Lower is better. Penalises large plants next to large plants, and any plant directly below a large one. */
function shadePenalty(model: Model, s: Slot, plant: Plant, placed: Map<number, Plant>): number {
  let p = 0
  for (const n of neighbours(model, s)) {
    const other = placed.get(n.slot)
    if (!other) continue
    if (plant.size === 'large' && other.size === 'large') p += 2
    if (other.size === 'large' && n.col === s.col && n.row === s.row - 1) p += 1
  }
  return p
}

function centreBias(model: Model, s: Slot): number {
  const m = MODELS[model]
  return Math.abs(s.col - (m.cols - 1) / 2) + Math.abs(s.row - (m.rows - 1) / 2) / m.rows
}

export interface RankedSlot {
  slot: Slot
  /** Zones away from the ideal. */
  fallback: number
  /** Index of the slot's zone in the plant's tolerated zones (0 = first choice). */
  pref: number
  reason: string
}

/** Candidate slots for one plant, best first, with how far each is from the ideal zone. */
export function rankSlots(model: Model, plant: Plant, taken: Set<number>, placed: Map<number, Plant> = new Map(), overrides?: PlanOverrides): RankedSlot[] {
  const m = MODELS[model]
  const free = slots(model).filter(s => !taken.has(s.slot))
  if (model === 'nursery') {
    // Nursery: no light zones, fill top-left first.
    return free.map(slot => ({ slot, fallback: 0, pref: 0, reason: 'nursery staging' }))
  }
  const custom = !!overrides?.allowedZones?.[plant.id]?.length
  const out: (RankedSlot & { score: number })[] = []
  if (plant.placement === 'bottomCenter' && m.cols >= 3 && !custom) {
    // Bottom of the middle column, lowest first (as lightZones.ts advises). A Studio has no middle column, so there it goes by its zone.
    const centre = free.filter(s => s.col === Math.floor(m.cols / 2) && s.row >= m.rows - 2)
    for (const s of centre) out.push({ slot: s, fallback: 0, pref: 0, reason: 'bottom of the middle column — the vine climbs into the high-light centre', score: -10 - s.row })
  }
  toleratedZones(plant, overrides).forEach((zone, pref) => {
    const fallback = Math.abs(ZONE_RANK[zone] - ZONE_RANK[plant.zone])
    const reason = custom
      ? (fallback === 0 ? `${zone} light zone` : `${zone} zone, allowed by the caller (ideal ${plant.zone})`)
      : (fallback === 0 ? `${zone} light zone` : `${plant.zone} zone full — one zone lower per Gardyn's guidance (${zone})`)
    for (const s of free.filter(x => x.zone === zone)) {
      if (out.some(o => o.slot.slot === s.slot)) continue
      out.push({ slot: s, fallback, pref, reason, score: pref * 100 + shadePenalty(model, s, plant, placed) * 10 + (plant.zone === 'high' ? centreBias(model, s) : 0) + s.slot / 1000 })
    }
  })
  return out.sort((a, b) => a.score - b.score).map(({ slot, fallback, pref, reason }) => ({ slot, fallback, pref, reason }))
}

/** `catalog` defaults to Gardyn's built-in plants; pass `catalogFor(store)` to include the unit's custom ones. */
export function planLayout(req: PlanRequest, catalog: Catalog = BUILTIN): PlanResult {
  const { model, overrides } = req
  const all = slots(model)
  const bySlot = new Map(all.map(s => [s.slot, s]))
  const occupied = req.occupied ?? {}
  const taken = new Set<number>(Object.keys(occupied).map(Number))
  const placed = new Map<number, Plant>()
  for (const [slot, id] of Object.entries(occupied)) {
    const p = catalog.get(id)
    if (p) placed.set(Number(slot), p)
  }
  const assignments: Assignment[] = []
  const unplaced: Unplaced[] = []
  const pinned = new Set<number>()
  const missing = (plantId: string): Unplaced => ({ plantId, plantName: plantId, reason: 'not in the catalog', code: 'not_in_catalog', wantZone: null, zones: [], blocking: [] })
  const assign = (s: Slot, plant: Plant, fallback: number, reason: string) => {
    taken.add(s.slot)
    placed.set(s.slot, plant)
    assignments.push({ slot: s.slot, row: s.row, col: s.col, slotZone: s.zone, plantId: plant.id, plantName: plant.name, wantZone: plant.zone, fallback, reason })
  }

  // 1. Pins: the caller's explicit slots, whatever the zone.
  const pinsLeft = new Map<string, number>()
  for (const pin of overrides?.pins ?? []) {
    const plant = catalog.get(pin.plantId)
    if (!plant) {
      unplaced.push(missing(pin.plantId))
      continue
    }
    pinsLeft.set(plant.id, (pinsLeft.get(plant.id) ?? 0) + 1)
    const s = bySlot.get(pin.slot)
    let bad: string | null = null
    if (!s) bad = `there is no pod ${pin.slot} on a ${MODELS[model].name}`
    else if (occupied[s.slot] !== undefined) bad = `pod ${s.slot} is already planted`
    else if (taken.has(s.slot)) bad = `pod ${s.slot} is pinned twice`
    if (!s || bad) {
      unplaced.push({ plantId: plant.id, plantName: plant.name, reason: `pinned, but ${bad}`, code: 'bad_pin', wantZone: plant.zone, zones: [], blocking: [] })
      continue
    }
    pinned.add(s.slot)
    const fallback = s.zone ? Math.abs(ZONE_RANK[s.zone] - ZONE_RANK[plant.zone]) : 0
    assign(s, plant, fallback, `pinned to pod ${s.slot} by the caller${fallback ? ` (${s.zone} light; ideal ${plant.zone})` : ''}`)
  }

  const queue: Plant[] = []
  for (const r of req.plants) {
    const p = catalog.get(r.plantId)
    if (!p) {
      unplaced.push(missing(r.plantId))
      continue
    }
    const used = Math.min(pinsLeft.get(p.id) ?? 0, r.count)
    pinsLeft.set(p.id, (pinsLeft.get(p.id) ?? 0) - used)
    for (let i = used; i < r.count; i++) queue.push(p)
  }
  // Constrained and demanding plants first: fixed placements, then high → low, large before normal.
  queue.sort((a, b) => (a.placement ? 0 : 1) - (b.placement ? 0 : 1) || ZONE_RANK[a.zone] - ZONE_RANK[b.zone] || (a.size === 'large' ? 0 : 1) - (b.size === 'large' ? 0 : 1))

  // 2. Every plant into its first-choice zone; 3. then the rest fall back.
  const deferred: Plant[] = []
  for (const plant of queue) {
    const best = rankSlots(model, plant, taken, placed, overrides)[0]
    if (best && best.pref === 0) assign(best.slot, plant, best.fallback, best.reason)
    else deferred.push(plant)
  }
  const noSpace: Plant[] = []
  for (const plant of deferred) {
    const best = rankSlots(model, plant, taken, placed, overrides)[0]
    if (best) assign(best.slot, plant, best.fallback, best.reason)
    else noSpace.push(plant)
  }
  assignments.sort((a, b) => a.slot - b.slot)

  const zones = summariseZones(model, occupied, assignments)
  for (const plant of noSpace) {
    if (model === 'nursery') {
      unplaced.push({ plantId: plant.id, plantName: plant.name, reason: 'no free pod in the nursery', code: 'no_space', wantZone: plant.zone, zones: [], blocking: [] })
      continue
    }
    const tol = toleratedZones(plant, overrides)
    const counts = tol.map((z) => {
      const inZone = all.filter(s => s.zone === z)
      return `${z} ${inZone.filter(s => taken.has(s.slot)).length}/${inZone.length}`
    }).join(', ')
    unplaced.push({
      plantId: plant.id,
      plantName: plant.name,
      reason: `no free slot in the ${tol.join(' or ')} zone${tol.length > 1 ? 's' : ''} (${counts} taken)`,
      code: 'no_space',
      wantZone: plant.zone,
      zones: tol,
      blocking: blockers(model, tol, occupied, assignments, catalog),
    })
  }

  const suggestions = model === 'nursery' ? [] : suggest(model, noSpace, { taken, placed, occupied, pinned, overrides })
  const out: PlanResult = { model, assignments, unplaced, free: all.filter(s => !taken.has(s.slot)).map(s => s.slot), zones, suggestions }
  if (overrides && (overrides.pins?.length || Object.keys(overrides.allowedZones ?? {}).length)) out.overrides = overrides
  return out
}

function summariseZones(model: Model, occupied: Record<number, string>, assignments: Assignment[]): ZoneSummary[] {
  const all = slots(model)
  const planned = new Set(assignments.map(a => a.slot))
  return ZONES.flatMap((zone) => {
    const inZone = all.filter(s => s.zone === zone)
    if (!inZone.length) return []
    const existing = inZone.filter(s => occupied[s.slot] !== undefined).length
    const plannedHere = inZone.filter(s => planned.has(s.slot)).length
    return [{ zone, rows: [...new Set(inZone.map(s => s.row))].sort((a, b) => a - b), slots: inZone.map(s => s.slot), total: inZone.length, existing, planned: plannedHere, free: inZone.length - existing - plannedHere }]
  })
}

function plantLabel(id: string, catalog: Catalog): string {
  return catalog.get(id)?.name ?? id.replace(/^unknown:/, '')
}

function blockers(model: Model, zones: Zone[], occupied: Record<number, string>, assignments: Assignment[], catalog: Catalog): Blocker[] {
  const existing = slots(model).filter(s => occupied[s.slot] !== undefined).map(s => ({ slot: s.slot, zone: s.zone, plantId: occupied[s.slot] as string, plantName: plantLabel(occupied[s.slot] as string, catalog), existing: true }))
  const planned = assignments.map(a => ({ slot: a.slot, zone: a.slotZone, plantId: a.plantId, plantName: a.plantName, existing: false }))
  return [...existing, ...planned].filter((b): b is Blocker => zones.includes(b.zone as Zone)).sort((a, b) => a.slot - b.slot)
}

interface LayoutState {
  taken: Set<number>
  placed: Map<number, Plant>
  occupied: Record<number, string>
  pinned: Set<number>
  overrides?: PlanOverrides
}

/**
 * Moves that make room for plants that did not fit: relocate a pod whose
 * plant tolerates a free slot elsewhere (planned pods before planted ones),
 * let the plant go one zone further down than Gardyn's rule, or, for a plant
 * that takes more light, up into the nearest brighter zone with free pods.
 */
function suggest(model: Model, noSpace: Plant[], st: LayoutState): Suggestion[] {
  const all = slots(model)
  const out: Suggestion[] = []
  for (const plant of [...new Map(noSpace.map(p => [p.id, p])).values()]) {
    const tol = toleratedZones(plant, st.overrides)
    const found = new Map<string, { s: Suggestion, cost: number }>()
    tol.forEach((zone, pref) => {
      for (const s of all.filter(x => x.zone === zone)) {
        const other = st.placed.get(s.slot)
        if (!other || st.pinned.has(s.slot)) continue
        const existing = st.occupied[s.slot] !== undefined
        const alt = rankSlots(model, other, st.taken, st.placed, st.overrides)[0]
        if (!alt?.slot.zone) continue
        const key = `${other.id}:${zone}:${existing}`
        const cost = pref * 10 + alt.fallback + (existing ? 5 : 0)
        if ((found.get(key)?.cost ?? Infinity) <= cost) continue
        const where = alt.slot.zone === other.zone ? `its ideal ${alt.slot.zone} zone` : `${alt.slot.zone} light, which it tolerates`
        const text = existing
          ? `Move the ${other.name} already in pod ${s.slot} to pod ${alt.slot.slot} (${where}), then ${plant.name} fits in pod ${s.slot} (${zone}).`
          : `Move ${other.name} from pod ${s.slot} to pod ${alt.slot.slot} (${where}) so ${plant.name} can take pod ${s.slot} (${zone}).`
        const pins = [...(st.overrides?.pins ?? []), { slot: s.slot, plantId: plant.id }, { slot: alt.slot.slot, plantId: other.id }]
        found.set(key, {
          cost,
          s: {
            plantId: plant.id,
            plantName: plant.name,
            kind: 'relocate',
            slot: s.slot,
            zone,
            move: { plantId: other.id, plantName: other.name, from: s.slot, to: alt.slot.slot, toZone: alt.slot.zone, existing },
            text,
            overrides: existing ? null : { ...st.overrides, pins },
          },
        })
      }
    })
    const lowest = [...tol].sort((a, b) => ZONE_RANK[b] - ZONE_RANK[a])[0] as Zone
    const below = LOWER[lowest]
    const freeBelow = below ? all.filter(s => s.zone === below && !st.taken.has(s.slot)) : []
    if (below && freeBelow[0]) {
      found.set('allow_lower', {
        cost: 20,
        s: {
          plantId: plant.id,
          plantName: plant.name,
          kind: 'allow_lower',
          slot: freeBelow[0].slot,
          zone: below,
          move: null,
          text: `Allow ${plant.name} in the ${below} zone too (${freeBelow.length} free) — lower than Gardyn advises, so expect slower growth.`,
          overrides: { ...st.overrides, allowedZones: { ...st.overrides?.allowedZones, [plant.id]: [...tol, below] } },
        },
      })
    }
    const brighter = TAKES_MORE_LIGHT.has(plant.category) ? higherZones(plant.zone).filter(z => !tol.includes(z)) : []
    for (const up of brighter) {
      const free = all.filter(s => s.zone === up && !st.taken.has(s.slot))
      if (!free[0]) continue
      found.set('allow_higher', {
        cost: 25,
        s: {
          plantId: plant.id,
          plantName: plant.name,
          kind: 'allow_higher',
          slot: free[0].slot,
          zone: up,
          move: null,
          text: `Allow ${plant.name} in the ${up} zone too (${free.length} free) — more light than its ideal ${plant.zone} zone, which ${plant.category}s tolerate.`,
          overrides: { ...st.overrides, allowedZones: { ...st.overrides?.allowedZones, [plant.id]: [...tol, up] } },
        },
      })
      break
    }
    out.push(...[...found.values()].sort((a, b) => a.cost - b.cost).slice(0, 3).map(f => f.s))
  }
  return out
}

/** Zones brighter than `zone`, nearest first. */
function higherZones(zone: Zone): Zone[] {
  const out: Zone[] = []
  for (let z = HIGHER[zone]; z; z = HIGHER[z]) out.push(z)
  return out
}

/** Best free slots for adding one plant ("just want to replace a pod?"). */
export function bestSpots(model: Model, plantId: string, occupied: Record<number, string> = {}, limit = 5, catalog: Catalog = BUILTIN) {
  const plant = catalog.get(plantId)
  if (!plant) return []
  const placed = new Map<number, Plant>()
  for (const [slot, id] of Object.entries(occupied)) {
    const p = catalog.get(id)
    if (p) placed.set(Number(slot), p)
  }
  return rankSlots(model, plant, new Set(Object.keys(occupied).map(Number)), placed).slice(0, limit).map(r => ({ slot: r.slot.slot, zone: r.slot.zone, fallback: r.fallback, reason: r.reason }))
}

export interface SowingWave {
  plantId: string
  plantName: string
  wave: number
  /** YYYY-MM-DD */
  sowOn: string
  firstHarvestFrom: string
  firstHarvestTo: string
  harvestEstimated: boolean
}

const DAY = 86_400_000
function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Staggered sowing following Gardyn's succession table: the next yCube of the
 * same plant starts when the previous one reaches harvest-ready maturity
 * (window start) plus the group's gap. Flowers and single pods get one wave.
 */
export function sowingPlan(plants: { plantId: string, count: number }[], start: Date, mode: 'staggered' | 'batch' = 'staggered', catalog: Catalog = BUILTIN): SowingWave[] {
  const out: SowingWave[] = []
  for (const r of plants) {
    const p = catalog.get(r.plantId)
    if (!p) continue
    const gap = SUCCESSION_GAP_DAYS[p.succession]
    const cadence = mode === 'batch' || gap === null ? 0 : p.harvestMonths[0] * 30 + gap
    for (let i = 0; i < r.count; i++) {
      const sow = new Date(start.getTime() + i * cadence * DAY)
      out.push({
        plantId: p.id,
        plantName: p.name,
        wave: cadence === 0 ? 1 : i + 1,
        sowOn: iso(sow),
        firstHarvestFrom: iso(new Date(sow.getTime() + p.harvestMonths[0] * 30 * DAY)),
        firstHarvestTo: iso(new Date(sow.getTime() + p.harvestMonths[1] * 30 * DAY)),
        harvestEstimated: p.harvestEstimated,
      })
    }
  }
  return out.sort((a, b) => a.sowOn.localeCompare(b.sowOn) || a.plantName.localeCompare(b.plantName))
}
