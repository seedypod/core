/**
 * Pod planner — clean-room implementation of Gardyn's published placement
 * rules (help.mygardyn.com/en/articles/11567361):
 *
 *  1. Each plant goes in its light zone (catalog `zone`).
 *  2. "If the ideal spot is unavailable, place your plants one light zone
 *     lower." We step down high → medium → low and flag the move; we never
 *     substitute a different plant (My Pod Planner does — see
 *     knowledge/evaluation/mypodplanner-crosscheck-2026-11-02.md).
 *  3. Cucumbers start in the bottom of the middle column so the vine grows
 *     into higher light (Gardyn's explicit exception).
 *  4. "Leave space between larger plants so they do not block light from
 *     smaller plants nearby": large plants are spread apart by an adjacency
 *     penalty when choosing among equally good slots.
 *
 * Pure and deterministic; no clock, no I/O.
 */
import { getPlant, type Plant, SUCCESSION_GAP_DAYS, type Zone } from './catalog'
import { type Model, MODELS, type Slot, slots } from './zones'

const LOWER: Record<Zone, Zone | null> = { high: 'medium', medium: 'low', low: null }
const ZONE_RANK: Record<Zone, number> = { high: 0, medium: 1, low: 2 }

export interface PlanRequest {
  model: Model
  /** Plant ids with how many pods of each. */
  plants: { plantId: string, count: number }[]
  /** Slots already taken (existing pods): slot → plant id (or any truthy marker). */
  occupied?: Record<number, string>
}

export interface Assignment {
  slot: number
  row: number
  col: number
  slotZone: Zone | null
  plantId: string
  plantName: string
  wantZone: Zone
  /** Zones stepped down from the ideal (0 = ideal). */
  fallback: number
  reason: string
}

export interface PlanResult {
  model: Model
  assignments: Assignment[]
  unplaced: { plantId: string, plantName: string, reason: string }[]
  free: number[]
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

/** Candidate slots for one plant, best first, with how far each is from the ideal zone. */
export function rankSlots(model: Model, plant: Plant, taken: Set<number>, placed: Map<number, Plant> = new Map()): { slot: Slot, fallback: number, reason: string }[] {
  const m = MODELS[model]
  const free = slots(model).filter(s => !taken.has(s.slot))
  if (model === 'nursery') {
    // Nursery: no light zones, fill top-left first.
    return free.map(slot => ({ slot, fallback: 0, reason: 'nursery staging' }))
  }
  const out: { slot: Slot, fallback: number, reason: string, score: number }[] = []
  if (plant.placement === 'bottomCenter' && m.cols >= 3) {
    // Bottom of the middle column, lowest first (as lightZones.ts advises). A Studio has no middle column, so there it goes by its zone.
    const centre = free.filter(s => s.col === Math.floor(m.cols / 2) && s.row >= m.rows - 2)
    for (const s of centre) out.push({ slot: s, fallback: 0, reason: 'bottom of the middle column — the vine climbs into the high-light centre', score: -10 - s.row })
  }
  let zone: Zone | null = plant.zone
  let depth = 0
  while (zone) {
    for (const s of free.filter(x => x.zone === zone)) {
      if (out.some(o => o.slot.slot === s.slot)) continue
      const reason = depth === 0 ? `${zone} light zone` : `${plant.zone} zone full — one zone lower per Gardyn's guidance (${zone})`
      out.push({ slot: s, fallback: depth, reason, score: depth * 100 + shadePenalty(model, s, plant, placed) * 10 + (plant.zone === 'high' ? centreBias(model, s) : 0) + s.slot / 1000 })
    }
    zone = LOWER[zone]
    depth++
  }
  return out.sort((a, b) => a.score - b.score).map(({ slot, fallback, reason }) => ({ slot, fallback, reason }))
}

export function planLayout(req: PlanRequest): PlanResult {
  const taken = new Set<number>(Object.keys(req.occupied ?? {}).map(Number))
  const placed = new Map<number, Plant>()
  for (const [slot, id] of Object.entries(req.occupied ?? {})) {
    const p = getPlant(id)
    if (p) placed.set(Number(slot), p)
  }
  const queue: Plant[] = []
  const unplaced: PlanResult['unplaced'] = []
  for (const r of req.plants) {
    const p = getPlant(r.plantId)
    if (!p) {
      unplaced.push({ plantId: r.plantId, plantName: r.plantId, reason: 'not in the catalog' })
      continue
    }
    for (let i = 0; i < r.count; i++) queue.push(p)
  }
  // Constrained and demanding plants first: fixed placements, then high → low, large before normal.
  queue.sort((a, b) => (a.placement ? 0 : 1) - (b.placement ? 0 : 1) || ZONE_RANK[a.zone] - ZONE_RANK[b.zone] || (a.size === 'large' ? 0 : 1) - (b.size === 'large' ? 0 : 1))

  const assignments: Assignment[] = []
  for (const plant of queue) {
    const best = rankSlots(req.model, plant, taken, placed)[0]
    if (!best) {
      unplaced.push({ plantId: plant.id, plantName: plant.name, reason: `no free slot in the ${plant.zone} zone or below` })
      continue
    }
    taken.add(best.slot.slot)
    placed.set(best.slot.slot, plant)
    assignments.push({ slot: best.slot.slot, row: best.slot.row, col: best.slot.col, slotZone: best.slot.zone, plantId: plant.id, plantName: plant.name, wantZone: plant.zone, fallback: best.fallback, reason: best.reason })
  }
  assignments.sort((a, b) => a.slot - b.slot)
  return { model: req.model, assignments, unplaced, free: slots(req.model).filter(s => !taken.has(s.slot)).map(s => s.slot) }
}

/** Best free slots for adding one plant ("just want to replace a pod?"). */
export function bestSpots(model: Model, plantId: string, occupied: Record<number, string> = {}, limit = 5) {
  const plant = getPlant(plantId)
  if (!plant) return []
  const placed = new Map<number, Plant>()
  for (const [slot, id] of Object.entries(occupied)) {
    const p = getPlant(id)
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
export function sowingPlan(plants: { plantId: string, count: number }[], start: Date, mode: 'staggered' | 'batch' = 'staggered'): SowingWave[] {
  const out: SowingWave[] = []
  for (const r of plants) {
    const p = getPlant(r.plantId)
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
