/**
 * Pods out of order (#224). The owner moves yCubes by hand, so the tower can
 * drift from the pod records and from the plan. Where a pod's dot code is one
 * the owner has confirmed, the tower says what that pod holds; this compares
 * that with the record and the active plan and works out two fixes:
 *
 * - Update the records to match the tower: swaps of pod records between the
 *   mismatched pods (grow.swapPods' semantics: each record keeps its sowing
 *   date, status, notes and last cut).
 * - Move the pods to match the plan: physical swaps for the owner to make.
 *
 * Only pods whose code was read and confirmed take part. An unread pod, or one
 * whose code has no confirmed plant, is never moved or corrected, and a
 * mismatch that needs one is left unresolved rather than guessed.
 */
import type { Pod, Store } from '../store/types'
import { profileKey } from '../store/types'

/** One pod whose confirmed code disagrees with its record or the plan. */
export interface OrderSlot {
  slot: number
  code: string
  /** What the tower holds there, from the confirmed code. */
  tower: string
  record: string | null
  /** What the active plan puts there, or null with no plan or nothing planned there. */
  plan: string | null
}

export interface PodOrder {
  slots: OrderSlot[]
  /** Fix 1: swap these pods' records, in order, to match the tower. */
  recordSwaps: Array<[number, number]>
  /** Pods whose record no swap can fix: no other mismatched pod's record holds its plant. */
  recordsUnresolved: number[]
  /** Fix 2: swap these pods on the tower, in order, to match the plan; empty with no plan. */
  moves: Array<[number, number]>
  /** Pods whose planned plant isn't on any other mismatched pod. */
  movesUnresolved: number[]
  plan: { id: string, name: string } | null
  /** Pods with no confirmed code, which this never touches. */
  unknown: number
  /** Changes whenever what's out of order does, so a fix is only applied to what was shown. */
  key: string
}

const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : profileKey(a) === profileKey(b))

/** The plan applied last, which is the one the tower should follow. */
export function activePlan(store: Pick<Store, 'plans'>) {
  return store.plans.list().filter(p => p.appliedAt).sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))[0] ?? null
}

/**
 * Swaps, among `slots`, that make `have` match `want` wherever another slot
 * holds the wanted plant and is itself wrong; the rest are unresolved.
 */
function swapsToMatch(slots: number[], want: Map<number, string | null>, have: Map<number, string | null>): { swaps: Array<[number, number]>, unresolved: number[] } {
  const now = new Map(have)
  const swaps: Array<[number, number]> = []
  const unresolved: number[] = []
  const wrong = (s: number) => !same(now.get(s) ?? null, want.get(s) ?? null)
  for (const s of slots) {
    if (!wrong(s)) continue
    // Prefer the pod whose own wanted plant is what s holds now: one swap fixes both.
    const candidates = slots.filter(r => r !== s && wrong(r) && same(now.get(r) ?? null, want.get(s) ?? null))
    const r = candidates.find(c => same(want.get(c) ?? null, now.get(s) ?? null)) ?? candidates[0]
    if (r === undefined) {
      unresolved.push(s)
      continue
    }
    const held = now.get(s) ?? null
    now.set(s, now.get(r) ?? null)
    now.set(r, held)
    swaps.push([Math.min(s, r), Math.max(s, r)])
  }
  return { swaps, unresolved: unresolved.filter(wrong) }
}

/** What's out of order, or null when every pod with a confirmed code matches its record and the plan. */
export function podOrder(store: Pick<Store, 'podCodes' | 'pods' | 'plans'>): PodOrder | null {
  const pairs = new Map(store.podCodes.pairs().map(p => [p.code, p.plant]))
  const pods = new Map(store.pods.list().map(p => [p.slot, p]))
  const plan = activePlan(store)
  const planned = new Map((plan?.layout.assignments ?? []).map(a => [a.slot, a.plantName]))
  const known = store.podCodes.reads().flatMap(r => (r.code && pairs.has(r.code) ? [{ slot: r.slot, code: r.code, tower: pairs.get(r.code) as string }] : []))
  const all: OrderSlot[] = known.map(k => ({ ...k, record: pods.get(k.slot)?.plant ?? null, plan: plan ? planned.get(k.slot) ?? null : null }))
  const slots = all.filter(s => !same(s.tower, s.record) || (plan && !same(s.tower, s.plan)))
  if (!slots.length) return null
  const tower = new Map(all.map(s => [s.slot, s.tower as string | null]))
  const records = swapsToMatch(all.filter(s => !same(s.tower, s.record)).map(s => s.slot), tower, new Map(all.map(s => [s.slot, s.record])))
  const moves = plan
    ? swapsToMatch(all.filter(s => !same(s.tower, s.plan)).map(s => s.slot), new Map(all.map(s => [s.slot, s.plan])), tower)
    : { swaps: [], unresolved: [] }
  return {
    slots,
    recordSwaps: records.swaps,
    recordsUnresolved: records.unresolved,
    moves: moves.swaps,
    movesUnresolved: moves.unresolved,
    plan: plan ? { id: plan.id, name: plan.name } : null,
    unknown: pods.size - known.length,
    key: JSON.stringify(slots.map(s => [s.slot, s.tower, s.record, s.plan])),
  }
}

/** Swap what two pods hold, as grow.swapPods does: plant, sowing date, status, notes and last cut. */
export function swapPodRecords(store: Pick<Store, 'pods'>, a: number, b: number, ts: string): Pod[] {
  const pods = store.pods.list()
  const pa = pods.find(p => p.slot === a)
  const pb = pods.find(p => p.slot === b)
  if (!pa || !pb) throw new Error(`no pod ${pa ? b : a}`)
  if (a === b) return [pa, pb]
  const holds = (p: Pod) => ({ plant: p.plant, plantedAt: p.plantedAt, status: p.status, notes: p.notes, lastHarvestAt: p.lastHarvestAt })
  return [store.pods.update(a, holds(pb), ts), store.pods.update(b, holds(pa), ts)]
}
