import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import type { PlanRow } from '../../store/types'
import { activePlan, podOrder, swapPodRecords } from '../podOrder'

const T = '2026-11-11T21:00:00.000Z'

/** A unit with these pod records, these codes read and confirmed, and optionally a plan. */
function unit(o: { records: Record<number, string>, reads: Record<number, string | null>, pairs: Record<string, string>, plan?: Record<number, string> }) {
  const store = new MemoryStore(15)
  for (const [slot, plant] of Object.entries(o.records)) store.pods.update(Number(slot), { plant, plantedAt: `2026-11-0${slot.padStart(2, '0').slice(-1)}`, status: 'growing', notes: `pod ${slot}'s notes` }, T)
  for (const [code, plant] of Object.entries(o.pairs)) store.podCodes.confirm(code, plant, T)
  store.podCodes.setReads('upper', Object.entries(o.reads).map(([slot, code]) => ({ slot: Number(slot), camera: 'upper' as const, code, confidence: code ? 0.9 : 0.1, ts: T })))
  if (o.plan) {
    const assignments = Object.entries(o.plan).map(([slot, plantName]) => ({ slot: Number(slot), plantId: plantName.toLowerCase(), plantName }))
    store.plans.save({ id: 'p1', name: 'Autumn', model: 'home', mode: 'batch', request: [], layout: { assignments } as unknown as PlanRow['layout'], sowing: [] })
    store.plans.markApplied('p1', T)
  }
  return store
}

const PAIRS = { 'oo||': 'Basil', 'o|hh': 'Thyme', 'ooh|': 'Chives', 'o||o': 'Oregano' }

describe('podOrder (#224)', () => {
  it('is null when every confirmed code matches its record and the plan, whatever the unread pods hold', () => {
    const store = unit({ records: { 1: 'Basil', 2: 'Thyme', 3: 'Kale' }, reads: { 1: 'oo||', 2: 'o|hh', 3: null }, pairs: PAIRS, plan: { 1: 'Basil', 2: 'Thyme', 3: 'Mint' } })
    expect(podOrder(store)).toBeNull()
  })

  it('finds two pods swapped by hand, and both fixes are one swap', () => {
    const store = unit({ records: { 2: 'Thyme', 7: 'Basil' }, reads: { 2: 'oo||', 7: 'o|hh' }, pairs: PAIRS, plan: { 2: 'Thyme', 7: 'Basil' } })
    const o = podOrder(store)
    expect(o).toMatchObject({
      slots: [{ slot: 2, code: 'oo||', tower: 'Basil', record: 'Thyme', plan: 'Thyme' }, { slot: 7, code: 'o|hh', tower: 'Thyme', record: 'Basil', plan: 'Basil' }],
      recordSwaps: [[2, 7]],
      recordsUnresolved: [],
      moves: [[2, 7]],
      movesUnresolved: [],
      plan: { id: 'p1', name: 'Autumn' },
      unknown: 13,
    })
  })

  it('untangles a three-way move in two swaps', () => {
    const store = unit({ records: { 1: 'Basil', 2: 'Thyme', 3: 'Chives' }, reads: { 1: 'o|hh', 2: 'ooh|', 3: 'oo||' }, pairs: PAIRS })
    const o = podOrder(store)
    expect(o?.recordSwaps).toHaveLength(2)
    expect(o?.moves).toEqual([])
    expect(o?.plan).toBeNull()
    // Applying the swaps leaves every record as the tower has it, each with its own sowing date and notes.
    for (const [a, b] of o?.recordSwaps ?? []) swapPodRecords(store, a, b, T)
    const pods = store.pods.list()
    expect(pods.slice(0, 3).map(p => [p.plant, p.notes])).toEqual([['Thyme', 'pod 2\'s notes'], ['Chives', 'pod 3\'s notes'], ['Basil', 'pod 1\'s notes']])
    expect(podOrder(store)).toBeNull()
  })

  it('never moves a record into or out of a pod it can\'t read', () => {
    // Pod 2 reads as Basil, but the Basil record is on pod 5, which wasn't read: nothing to swap with.
    const store = unit({ records: { 2: 'Thyme', 5: 'Basil' }, reads: { 2: 'oo||', 5: null }, pairs: PAIRS })
    expect(podOrder(store)).toMatchObject({ slots: [{ slot: 2 }], recordSwaps: [], recordsUnresolved: [2] })
  })

  it('ignores codes the owner hasn\'t confirmed', () => {
    const store = unit({ records: { 2: 'Thyme', 7: 'Basil' }, reads: { 2: 'hhhh', 7: 'o|hh' }, pairs: PAIRS })
    expect(podOrder(store)).toMatchObject({ slots: [{ slot: 7 }], recordSwaps: [], recordsUnresolved: [7] })
  })

  it('checks the plan separately: records right, tower off plan, gives only moves', () => {
    const store = unit({ records: { 1: 'Basil', 4: 'Thyme', 9: 'Oregano' }, reads: { 1: 'oo||', 4: 'o|hh', 9: 'o||o' }, pairs: PAIRS, plan: { 1: 'Thyme', 4: 'Basil', 9: 'Kale' } })
    const o = podOrder(store)
    expect(o?.slots.map(s => s.slot)).toEqual([1, 4, 9])
    expect(o?.recordSwaps).toEqual([])
    expect(o?.moves).toEqual([[1, 4]])
    // No read pod holds Kale.
    expect(o?.movesUnresolved).toEqual([9])
  })

  it('matches names as plant profiles do, and changes its key when the mismatch does', () => {
    const store = unit({ records: { 1: 'basil ', 2: 'Thyme', 7: 'Basil' }, reads: { 1: 'oo||', 2: 'oo||', 7: 'o|hh' }, pairs: PAIRS })
    const first = podOrder(store)
    expect(first?.slots.map(s => s.slot)).toEqual([2, 7])
    store.pods.update(7, { plant: 'Mint' }, T)
    expect(podOrder(store)?.key).not.toBe(first?.key)
  })

  it('takes the plan applied last', () => {
    const store = unit({ records: {}, reads: {}, pairs: {} })
    const save = (id: string) => store.plans.save({ id, name: id, model: 'home', mode: 'batch', request: [], layout: { assignments: [] } as unknown as PlanRow['layout'], sowing: [] })
    save('a')
    save('b')
    save('c')
    expect(activePlan(store)).toBeNull()
    store.plans.markApplied('b', '2026-11-02T00:00:00.000Z')
    store.plans.markApplied('a', '2026-11-01T00:00:00.000Z')
    expect(activePlan(store)?.id).toBe('b')
  })

  it('refuses to swap a pod that isn\'t there', () => {
    const store = unit({ records: { 1: 'Basil' }, reads: {}, pairs: {} })
    expect(() => swapPodRecords(store, 1, 99, T)).toThrow('no pod 99')
    expect(() => swapPodRecords(store, 99, 1, T)).toThrow('no pod 99')
    expect(swapPodRecords(store, 1, 1, T).map(p => p.plant)).toEqual(['Basil', 'Basil'])
  })
})
