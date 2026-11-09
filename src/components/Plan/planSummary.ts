/**
 * What a saved plan's card says about it: its plants by name with counts, how
 * full it makes the tower, what didn't fit, when it was saved, and what
 * applying it would do. Pure, for the card and its tests.
 */
import { MODELS } from '@/src/plants/zones'

export interface SavedPlan {
  id: string
  name: string
  model: keyof typeof MODELS
  request: { plantId: string, count: number }[]
  layout: { assignments: { slot: number, plantId: string, plantName: string }[], unplaced: { plantId: string, plantName: string }[] }
  sowing?: { plantId: string, sowOn: string }[]
  createdAt?: string
  updatedAt?: string
  appliedAt: string | null
}

export interface PlanChip { plantId: string, name: string, count: number }

/** A catalog id as words, for a plant nothing names any more: "italian-parsley" → "Italian Parsley". */
export function idToName(id: string): string {
  return id.split(/[-_\s]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || id
}

/**
 * Each requested plant's display name: the catalog's (custom plants included),
 * else the name the plan's own layout recorded, else the id in words.
 */
export function plantNames(plan: SavedPlan, catalog: { id: string, name: string }[]): Map<string, string> {
  const known = new Map(catalog.map(p => [p.id, p.name]))
  const recorded = new Map([...plan.layout.assignments, ...plan.layout.unplaced].map(a => [a.plantId, a.plantName]))
  return new Map(plan.request.map(r => [r.plantId, known.get(r.plantId) ?? recorded.get(r.plantId) ?? idToName(r.plantId)]))
}

/** The plan's plants as chips, one per plant with its count, in the order asked; the first `limit` shown and the rest held back. */
export function planChips(plan: SavedPlan, names: Map<string, string>, limit = 6): { shown: PlanChip[], hidden: PlanChip[] } {
  const counts = new Map<string, number>()
  for (const r of plan.request) counts.set(r.plantId, (counts.get(r.plantId) ?? 0) + r.count)
  const chips = [...counts].map(([plantId, count]) => ({ plantId, name: names.get(plantId) ?? idToName(plantId), count }))
  // Holding back a single chip saves no room over showing it.
  const cut = chips.length > limit + 1 ? limit : chips.length
  return { shown: chips.slice(0, cut), hidden: chips.slice(cut) }
}

export interface PlanMeta {
  /** "Gardyn Home". */
  model: string
  placed: number
  capacity: number
  unplaced: number
  /** "Saved" or "Updated", and when. */
  when: { verb: 'Saved' | 'Updated', at: string } | null
}

export function planMeta(plan: SavedPlan): PlanMeta {
  const m = MODELS[plan.model]
  const changed = plan.updatedAt && plan.createdAt && plan.updatedAt !== plan.createdAt
  const at = plan.updatedAt ?? plan.createdAt
  return {
    model: m.name,
    placed: plan.layout.assignments.length,
    capacity: m.pods,
    unplaced: plan.layout.unplaced.length,
    when: at ? { verb: changed ? 'Updated' : 'Saved', at } : null,
  }
}

/** "Nov 9" for a time this year, "Nov 9, 2025" for another; a bare date (YYYY-MM-DD) stays that day in any time zone. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const timeZone = iso.length === 10 ? 'UTC' : undefined
  const year = (x: Date) => timeZone ? x.getUTCFullYear() : x.getFullYear()
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(timeZone && { timeZone }), ...(year(d) !== year(now) && { year: 'numeric' }) })
}

/**
 * What applying the plan does, as the server's applyPlan does it: each plant's
 * pods (in slot order) take its sowing waves in turn; a pod whose wave is due
 * by `today` (YYYY-MM-DD) is marked seeded, a later one waits with its sow date
 * and a reminder.
 */
export function applyPreview(plan: SavedPlan, today: string): { now: number, later: number, nextSow: string | null } {
  const waves = new Map<string, string[]>()
  for (const w of plan.sowing ?? []) waves.set(w.plantId, [...(waves.get(w.plantId) ?? []), w.sowOn])
  const used = new Map<string, number>()
  let now = 0
  const later: string[] = []
  for (const a of plan.layout.assignments) {
    const i = used.get(a.plantId) ?? 0
    used.set(a.plantId, i + 1)
    const sowOn = waves.get(a.plantId)?.[i] ?? today
    if (sowOn <= today) now++
    else later.push(sowOn)
  }
  return { now, later: later.length, nextSow: later.sort()[0] ?? null }
}
