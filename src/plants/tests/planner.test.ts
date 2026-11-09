import { describe, expect, it } from 'vitest'
import { PLANT_ZONE_MAP } from '../../components/Grow/lightZones'
import { findPlant, getPlant, PLANTS, searchPlants, SUCCESSION_GAP_DAYS } from '../catalog'
import { bestSpots, planLayout, rankSlots, sowingPlan } from '../planner'
import { MODELS, slotAt, slots, zoneCounts } from '../zones'

describe('catalog', () => {
  it('loads every plant from the generated JSON with Gardyn zones', () => {
    expect(PLANTS.length).toBeGreaterThanOrEqual(130)
    expect(getPlant('basil')).toMatchObject({ zone: 'medium', careLevel: 'beginner', harvestMonths: [2, 3], harvestEstimated: false })
    expect(getPlant('cucumber')?.placement).toBe('bottomCenter')
    expect(findPlant('Jalapeño')?.id).toBe('jalapeno')
    expect(searchPlants({ zone: 'low', category: 'herb' }).map(p => p.id)).toContain('mint')
    expect(SUCCESSION_GAP_DAYS.flowers).toBeNull()
  })
})

describe('catalog agrees with core’s light-zone guide', () => {
  it('gives every plant core lists the same zone', () => {
    const mismatched = PLANTS.filter(p => PLANT_ZONE_MAP.has(p.name) && PLANT_ZONE_MAP.get(p.name) !== p.zone).map(p => `${p.name}: ${p.zone} vs ${PLANT_ZONE_MAP.get(p.name)}`)
    expect(mismatched).toEqual([])
    expect(PLANTS.filter(p => PLANT_ZONE_MAP.has(p.name)).length).toBeGreaterThan(100)
  })
})

describe('zones (measured from Gardyn’s map)', () => {
  it('has the official zone counts and corner pattern', () => {
    expect(zoneCounts('home')).toEqual({ high: 12, medium: 12, low: 6 })
    expect(zoneCounts('studio')).toEqual({ high: 5, medium: 9, low: 2 })
    // Studio: low is lower-left and upper-right
    expect(slotAt('studio', 2)?.zone).toBe('low')
    expect(slotAt('studio', 15)?.zone).toBe('low')
    // Home: centre column rows 3–8 are all high
    expect([8, 11, 14, 17, 20, 23].map(s => slotAt('home', s)?.zone)).toEqual(Array(6).fill('high'))
    expect(slots('home')).toHaveLength(30)
    expect(slots('nursery').every(s => s.zone === null)).toBe(true)
    expect(MODELS.home).toMatchObject({ cols: 3, rows: 10 })
  })
})

describe('planLayout', () => {
  it('puts every plant in its zone when there is room', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 4 }, { plantId: 'mint', count: 2 }, { plantId: 'sweet-pepper', count: 2 }] })
    expect(r.unplaced).toEqual([])
    expect(r.assignments).toHaveLength(8)
    for (const a of r.assignments) {
      expect(a.slotZone).toBe(a.wantZone)
      expect(a.fallback).toBe(0)
    }
  })

  it('steps one zone lower when the ideal zone is full, never substitutes', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'jalapeno', count: 14 }] })
    const zones = r.assignments.map(a => a.slotZone)
    expect(zones.filter(z => z === 'high')).toHaveLength(12)
    expect(zones.filter(z => z === 'medium')).toHaveLength(2)
    expect(r.assignments.every(a => a.plantId === 'jalapeno')).toBe(true)
    expect(r.assignments.filter(a => a.fallback === 1)).toHaveLength(2)
  })

  it('reports plants that cannot fit in their zone or one lower', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'mint', count: 7 }] })
    expect(r.assignments).toHaveLength(6)
    expect(r.unplaced).toHaveLength(1)
    expect(r.unplaced[0]).toMatchObject({ code: 'no_space', zones: ['low'], reason: 'no free slot in the low zone (low 6/6 taken)' })
  })

  it('places cucumbers bottom-centre (Gardyn’s exception)', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'cucumber', count: 1 }] })
    expect(r.assignments[0]).toMatchObject({ slot: 29, row: 9, col: 1 })
    // A Studio has no middle column: the cucumber goes by its zone.
    const s = planLayout({ model: 'studio', plants: [{ plantId: 'cucumber', count: 1 }] })
    expect(s.assignments[0]?.slotZone).toBe('high')
  })

  it('spreads large plants apart to limit shading', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'red-cherry-tomato', count: 4 }] })
    const ss = r.assignments.map(a => ({ row: a.row, col: a.col }))
    const adjacent = ss.some((a, i) => ss.some((b, j) => i !== j && ((a.col === b.col && Math.abs(a.row - b.row) === 1) || (a.row === b.row && Math.abs(a.col - b.col) === 1))))
    expect(adjacent).toBe(false)
  })

  it('respects occupied slots and flags unknown plants', () => {
    const r = planLayout({ model: 'studio', plants: [{ plantId: 'basil', count: 1 }, { plantId: 'nope', count: 1 }], occupied: { 1: 'basil', 3: 'kale' } })
    expect(r.assignments.map(a => a.slot)).not.toContain(1)
    expect(r.unplaced[0]).toMatchObject({ plantId: 'nope', reason: 'not in the catalog' })
    expect(r.free).not.toContain(3)
  })

  it('nursery has no zones and fills in order', () => {
    const r = planLayout({ model: 'nursery', plants: [{ plantId: 'basil', count: 3 }] })
    expect(r.assignments.map(a => a.slot)).toEqual([1, 2, 3])
  })
})

describe('bestSpots / rankSlots', () => {
  it('ranks ideal-zone slots before fallbacks', () => {
    const spots = bestSpots('home', 'kale', {}, 20)
    expect(spots[0]?.fallback).toBe(0)
    expect(spots.every(s => s.zone !== 'high')).toBe(true) // never steps up
    expect(bestSpots('home', 'missing')).toEqual([])
    const plant = getPlant('mint')
    if (!plant) throw new Error('mint missing')
    expect(rankSlots('home', plant, new Set()).every(r => r.slot.zone === 'low')).toBe(true)
  })
})

describe('sowingPlan', () => {
  const start = new Date('2026-11-02T00:00:00Z')
  it('staggers by harvest-ready + Gardyn gap', () => {
    const w = sowingPlan([{ plantId: 'butterhead', count: 3 }], start)
    // lettuce: 1 month (30 d) + fast-greens gap 10 d = every 40 days
    expect(w.map(x => x.sowOn)).toEqual(['2026-11-02', '2026-12-12', '2027-01-21'])
    expect(w[0]).toMatchObject({ firstHarvestFrom: '2026-12-02', firstHarvestTo: '2027-01-01', wave: 1 })
  })
  it('flowers and batch mode sow together', () => {
    expect(new Set(sowingPlan([{ plantId: 'zinnia', count: 3 }], start).map(x => x.sowOn)).size).toBe(1)
    expect(new Set(sowingPlan([{ plantId: 'basil', count: 3 }], start, 'batch').map(x => x.sowOn)).size).toBe(1)
  })
})
