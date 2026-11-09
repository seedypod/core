import { describe, expect, it } from 'vitest'
import { getPlant } from '../catalog'
import { planLayout, toleratedZones } from '../planner'
import { MODELS, slotAt } from '../zones'

const plant = (id: string) => {
  const p = getPlant(id)
  if (!p) throw new Error(`${id} missing`)
  return p
}

describe('zone summary', () => {
  it('reports each zone’s rows, slots and how full it is', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 4 }], occupied: { 1: 'mint', 8: 'unknown:Weed' } })
    expect(r.zones.map(z => z.zone)).toEqual(['high', 'medium', 'low'])
    const [high, medium, low] = r.zones
    expect(high).toMatchObject({ total: 12, existing: 1, planned: 0, free: 11 })
    expect(medium).toMatchObject({ total: 12, existing: 0, planned: 4, free: 8 })
    expect(low).toMatchObject({ total: 6, existing: 1, planned: 0, free: 5, rows: [0, 9] })
    expect(low?.slots).toContain(1)
    expect(r.zones.reduce((n, z) => n + z.free, 0)).toBe(r.free.length)
  })

  it('is empty for the nursery, which has no zones', () => {
    const r = planLayout({ model: 'nursery', plants: [{ plantId: 'basil', count: 11 }] })
    expect(r.zones).toEqual([])
    expect(r.suggestions).toEqual([])
    expect(r.unplaced).toEqual([{ plantId: 'basil', plantName: 'Basil', reason: 'no free pod in the nursery', code: 'no_space', wantZone: 'medium', zones: [], blocking: [] }])
  })
})

describe('Gardyn’s fallback rule', () => {
  it('tolerates the ideal zone and one lower, or the caller’s zones nearest the ideal first', () => {
    expect(toleratedZones(plant('jalapeno'))).toEqual(['high', 'medium'])
    expect(toleratedZones(plant('mint'))).toEqual(['low'])
    expect(toleratedZones(plant('basil'), { allowedZones: { basil: ['high', 'low', 'medium', 'low'] } })).toEqual(['medium', 'low', 'high'])
  })

  it('gives every plant its ideal zone before any plant falls back', () => {
    // Basil overflows medium into low; mint still gets its own low zone.
    const r = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 18 }, { plantId: 'mint', count: 1 }] })
    expect(r.assignments.find(a => a.plantId === 'mint')).toMatchObject({ slotZone: 'low', fallback: 0 })
    expect(r.unplaced).toMatchObject([{ plantId: 'basil', code: 'no_space', zones: ['medium', 'low'] }])
  })

  it('never drops two zones without the caller’s say-so, and suggests allowing it', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'jalapeno', count: 25 }] })
    expect(r.assignments).toHaveLength(24)
    expect(r.assignments.some(a => a.slotZone === 'low')).toBe(false)
    const u = r.unplaced[0]
    expect(u).toMatchObject({ code: 'no_space', wantZone: 'high', zones: ['high', 'medium'], reason: 'no free slot in the high or medium zones (high 12/12, medium 12/12 taken)' })
    expect(u?.blocking).toHaveLength(24)
    expect(u?.blocking.every(b => !b.existing && b.plantId === 'jalapeno')).toBe(true)

    const s = r.suggestions[0]
    expect(s).toMatchObject({ kind: 'allow_lower', zone: 'low', move: null, overrides: { allowedZones: { jalapeno: ['high', 'medium', 'low'] } } })
    expect(s?.text).toMatch(/Allow Jalapeño in the low zone too \(6 free\)/)
    const again = planLayout({ model: 'home', plants: [{ plantId: 'jalapeno', count: 25 }], overrides: s?.overrides ?? undefined })
    expect(again.unplaced).toEqual([])
    expect(again.assignments.filter(a => a.slotZone === 'low')).toMatchObject([{ fallback: 2, reason: 'low zone, allowed by the caller (ideal high)' }])
    expect(again.overrides).toEqual(s?.overrides)
  })
})

describe('suggestions', () => {
  it('suggests moving a tolerant planned plant down to free a slot, and the overrides carry it out', () => {
    const plants = [{ plantId: 'jalapeno', count: 13 }, { plantId: 'basil', count: 12 }]
    const r = planLayout({ model: 'home', plants })
    expect(r.unplaced).toMatchObject([{ plantId: 'jalapeno', code: 'no_space' }])
    expect(r.suggestions.map(s => s.kind)).toEqual(['relocate', 'allow_lower'])
    const s = r.suggestions[0]
    if (!s?.move) throw new Error('no relocation')
    expect(s).toMatchObject({ plantId: 'jalapeno', zone: 'medium', move: { plantId: 'basil', from: s.slot, toZone: 'low', existing: false } })
    expect(slotAt('home', s.move.to)?.zone).toBe('low')
    expect(s.text).toBe(`Move Basil from pod ${s.slot} to pod ${s.move.to} (low light, which it tolerates) so Jalapeño can take pod ${s.slot} (medium).`)

    const again = planLayout({ model: 'home', plants, overrides: s.overrides ?? undefined })
    expect(again.unplaced).toEqual([])
    expect(again.assignments.find(a => a.slot === s.slot)).toMatchObject({ plantId: 'jalapeno', fallback: 1, reason: `pinned to pod ${s.slot} by the caller (medium light; ideal high)` })
    expect(again.assignments.find(a => a.slot === s.move?.to)).toMatchObject({ plantId: 'basil' })
    expect(again.assignments).toHaveLength(25)
  })

  it('suggests moving a planted pod back to its ideal zone, by hand', () => {
    // A basil already sits in low slot 1, so the sixth mint has nowhere to go.
    const r = planLayout({ model: 'home', plants: [{ plantId: 'mint', count: 6 }], occupied: { 1: 'basil' } })
    expect(r.unplaced[0]?.blocking).toContainEqual({ slot: 1, zone: 'low', plantId: 'basil', plantName: 'Basil', existing: true })
    expect(r.suggestions).toHaveLength(1)
    const s = r.suggestions[0]
    expect(s).toMatchObject({ kind: 'relocate', slot: 1, zone: 'low', overrides: null, move: { plantId: 'basil', from: 1, toZone: 'medium', existing: true } })
    expect(s?.text).toMatch(/^Move the Basil already in pod 1 to pod \d+ \(its ideal medium zone\), then Mint fits in pod 1 \(low\)\.$/)
  })

  it('does not suggest moving pinned pods or plants it cannot identify', () => {
    const low = [1, 2, 3, 28, 29, 30].filter(n => slotAt('home', n)?.zone === 'low')
    expect(low).toHaveLength(6)
    const r = planLayout({ model: 'home', plants: [{ plantId: 'mint', count: 1 }, { plantId: 'basil', count: 1 }], occupied: Object.fromEntries(low.slice(1).map(n => [n, 'unknown:Weed'])), overrides: { pins: [{ slot: low[0] as number, plantId: 'basil' }] } })
    expect(r.unplaced).toMatchObject([{ plantId: 'mint', blocking: expect.arrayContaining([{ slot: low[1], zone: 'low', plantId: 'unknown:Weed', plantName: 'Weed', existing: true }]) }])
    expect(r.suggestions).toEqual([])
  })
})

describe('caller overrides', () => {
  it('pins pods to slots, counted toward the plant’s pods; extra pins add pods', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 2 }, { plantId: 'kale', count: 1 }], overrides: { pins: [{ slot: 8, plantId: 'basil' }, { slot: 4, plantId: 'kale' }, { slot: 5, plantId: 'kale' }] } })
    expect(r.assignments.filter(a => a.plantId === 'basil')).toHaveLength(2)
    expect(r.assignments.find(a => a.slot === 8)).toMatchObject({ plantId: 'basil', slotZone: 'high', fallback: 1 })
    expect(r.assignments.filter(a => a.plantId === 'kale').map(a => a.slot)).toEqual([4, 5])
    expect(r.assignments.find(a => a.slot === 4)?.reason).toBe('pinned to pod 4 by the caller')
  })

  it('reports pins it cannot honour', () => {
    const r = planLayout({
      model: 'studio',
      plants: [],
      occupied: { 3: 'kale' },
      overrides: { pins: [{ slot: 99, plantId: 'basil' }, { slot: 3, plantId: 'basil' }, { slot: 4, plantId: 'basil' }, { slot: 4, plantId: 'kale' }, { slot: 5, plantId: 'nope' }] },
    })
    expect(r.unplaced.map(u => [u.code, u.reason])).toEqual([
      ['bad_pin', `pinned, but there is no pod 99 on a ${MODELS.studio.name}`],
      ['bad_pin', 'pinned, but pod 3 is already planted'],
      ['bad_pin', 'pinned, but pod 4 is pinned twice'],
      ['not_in_catalog', 'not in the catalog'],
    ])
    expect(r.assignments).toMatchObject([{ slot: 4, plantId: 'basil' }])
  })

  it('keeps a plant to the zones the caller allows', () => {
    const low = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 2 }], overrides: { allowedZones: { basil: ['low'] } } })
    expect(low.assignments.map(a => [a.slotZone, a.fallback, a.reason])).toEqual(Array(2).fill(['low', 1, 'low zone, allowed by the caller (ideal medium)']))

    const one = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 13 }], overrides: { allowedZones: { basil: ['medium'] } } })
    expect(one.assignments.every(a => a.slotZone === 'medium' && a.reason === 'medium light zone')).toBe(true)
    expect(one.unplaced).toMatchObject([{ zones: ['medium'], reason: 'no free slot in the medium zone (medium 12/12 taken)' }])
    expect(one.suggestions).toMatchObject([{ kind: 'allow_lower', zone: 'low', overrides: { allowedZones: { basil: ['medium', 'low'] } } }])
  })

  it('drops the cucumber’s bottom-centre start when the caller sets its zones', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'cucumber', count: 1 }], overrides: { allowedZones: { cucumber: ['high'] } } })
    expect(r.assignments[0]?.slotZone).toBe('high')
  })

  it('pins nursery pods too', () => {
    const r = planLayout({ model: 'nursery', plants: [{ plantId: 'basil', count: 1 }], overrides: { pins: [{ slot: 7, plantId: 'basil' }] } })
    expect(r.assignments).toMatchObject([{ slot: 7, slotZone: null, fallback: 0, reason: 'pinned to pod 7 by the caller' }])
  })

  it('echoes only overrides that say something', () => {
    expect(planLayout({ model: 'home', plants: [], overrides: {} }).overrides).toBeUndefined()
    expect(planLayout({ model: 'home', plants: [], overrides: { pins: [], allowedZones: {} } }).overrides).toBeUndefined()
  })
})
