/**
 * Zone tolerance: the light zones a plant does acceptably in beyond its ideal
 * one, each with a cost the planner weighs against crowding and shade. The
 * defaults come from Gardyn's guidance by category; the evidence is in
 * knowledge/plants/zone-tolerance.md. A custom plant can name its own zones.
 */
import type { Category, Zone } from './catalog'

const RANK: Record<Zone, number> = { high: 0, medium: 1, low: 2 }
const ALL: Zone[] = ['high', 'medium', 'low']

/** A zone beyond the ideal where a plant still does acceptably, and what placing it there costs (1 = Gardyn's one-zone-lower fallback). */
export interface Tolerance { zone: Zone, cost: number }

interface Shape { category: Category, zone: Zone, size: 'large' | 'normal' }

/**
 * What `zone` costs a plant whose ideal is `ideal`. One zone lower costs 1, as
 * Gardyn's own fallback; one higher 2, so lower still comes first; two lower
 * 3, two higher 4. A large plant moved up costs 1 more: in the brighter centre
 * it shades more neighbours.
 */
export function zoneCost(ideal: Zone, zone: Zone, size: Shape['size']): number {
  const d = RANK[zone] - RANK[ideal]
  if (d === 0) return 0
  return d > 0 ? 2 * d - 1 : -2 * d + (size === 'large' ? 1 : 0)
}

/**
 * Categories that also do fine one zone brighter: herbs (Gardyn puts them in
 * low to medium), flowers and legumes. Not lettuces, leafy greens or
 * vegetables: Gardyn warns more light hastens bolting.
 */
export const TAKES_MORE_LIGHT: ReadonlySet<Category> = new Set(['herb', 'flower', 'legume'])

/**
 * The zones a plant tolerates by default, cheapest first: one zone lower for
 * every plant (Gardyn's rule), except that fruiting plants never go below
 * medium, and one zone higher for herbs, flowers and legumes.
 */
export function defaultTolerance(p: Shape): Tolerance[] {
  const zones = ALL.filter((z) => {
    const d = RANK[z] - RANK[p.zone]
    if (d === 1) return !(p.category === 'fruiting' && z === 'low')
    return d === -1 && TAKES_MORE_LIGHT.has(p.category)
  })
  return toleranceIn(zones, p)
}

/** Named zones as tolerances, priced by `zoneCost`, cheapest first; the ideal zone is dropped. */
export function toleranceIn(zones: readonly Zone[], p: Pick<Shape, 'zone' | 'size'>): Tolerance[] {
  return [...new Set(zones)].filter(z => z !== p.zone).map(zone => ({ zone, cost: zoneCost(p.zone, zone, p.size) })).sort((a, b) => a.cost - b.cost)
}
