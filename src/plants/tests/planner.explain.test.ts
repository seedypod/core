import { describe, expect, it } from 'vitest'
import { getPlant } from '../catalog'
import { planLayout, toleratedZones } from '../planner'
import { MODELS, slotAt, slots } from '../zones'

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

describe('zone tolerance', () => {
  it('tolerates the ideal zone, then the zones the plant does ok in, cheapest first — or the caller’s zones', () => {
    expect(toleratedZones(plant('jalapeno'))).toEqual(['high', 'medium'])
    expect(toleratedZones(plant('mint'))).toEqual(['low', 'medium'])
    expect(toleratedZones(plant('basil'))).toEqual(['medium', 'low', 'high'])
    expect(toleratedZones(plant('butterhead'))).toEqual(['medium', 'low'])
    expect(toleratedZones(plant('arugula'))).toEqual(['low'])
    expect(toleratedZones(plant('basil'), { allowedZones: { basil: ['high', 'low', 'medium', 'low'] } })).toEqual(['medium', 'low', 'high'])
    expect(toleratedZones(plant('jalapeno'), { allowedZones: { jalapeno: ['low', 'medium'] } })).toEqual(['medium', 'low'])
  })

  it('gives every plant its ideal zone before any plant falls back, then one lower before one higher', () => {
    // Basil overflows medium into low, then high; mint still gets its own low zone.
    const r = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 18 }, { plantId: 'mint', count: 1 }] })
    expect(r.assignments.find(a => a.plantId === 'mint')).toMatchObject({ slotZone: 'low', fallback: 0, fit: 'ideal' })
    expect(r.unplaced).toEqual([])
    const off = r.assignments.filter(a => a.plantId === 'basil' && a.slotZone !== 'medium')
    expect(off.map(a => [a.slotZone, a.shift, a.fit])).toEqual([...Array(2).fill(['low', 'lower', 'ok']), ['high', 'higher', 'ok'], ...Array(3).fill(['low', 'lower', 'ok'])])
    expect(off.find(a => a.slotZone === 'low')?.reason).toBe('ok here — low light, one zone lower than its ideal medium, as Gardyn advises')
    expect(off.find(a => a.slotZone === 'high')?.reason).toBe('ok here — high light suits it too (ideal medium)')
  })

  it('weighs a tolerated zone against shade: a large plant takes open low pods before crowding the bright centre', () => {
    // Peas are large: one lower costs 1, one higher 3 (they would shade the centre).
    const r = planLayout({ model: 'home', plants: [{ plantId: 'peas', count: 14 }] })
    expect(r.assignments.filter(a => a.slotZone === 'high')).toEqual([])
    expect(r.assignments.filter(a => a.slotZone === 'low').map(a => a.slot)).toEqual([1, 3])
  })

  it('gives fruiting plants nothing below medium, and lettuces and leafy greens nothing brighter', () => {
    expect(planLayout({ model: 'home', plants: [{ plantId: 'jalapeno', count: 25 }] }).assignments.some(a => a.slotZone === 'low')).toBe(false)
    expect(planLayout({ model: 'home', plants: [{ plantId: 'butterhead', count: 19 }] }).assignments.some(a => a.slotZone === 'high')).toBe(false)
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
    // Two zones down costs 3, so a low pod with open sides beats a medium one boxed in by large peppers.
    const low = again.assignments.filter(a => a.slotZone === 'low')
    expect(low).toMatchObject(Array(2).fill({ fallback: 2, fit: 'ok', reason: 'low zone, allowed for this plan (ideal high)' }))
    expect(again.free.map(n => slotAt('home', n)?.zone)).toContain('medium')
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
    expect(again.assignments.find(a => a.slot === s.slot)).toMatchObject({ plantId: 'jalapeno', fallback: 1, fit: 'ok', reason: 'you placed it here — medium light, ok for it (ideal high)' })
    expect(again.assignments.find(a => a.slot === s.move?.to)).toMatchObject({ plantId: 'basil' })
    expect(again.assignments).toHaveLength(25)
  })

  it('suggests moving a planted pod back to its ideal zone, by hand', () => {
    // A basil already sits in low slot 1, so the sixth arugula (low only) has nowhere to go.
    const r = planLayout({ model: 'home', plants: [{ plantId: 'arugula', count: 6 }], occupied: { 1: 'basil' } })
    expect(r.unplaced[0]?.blocking).toContainEqual({ slot: 1, zone: 'low', plantId: 'basil', plantName: 'Basil', existing: true })
    expect(r.suggestions.map(s => s.kind)).toEqual(['relocate'])
    const s = r.suggestions[0]
    expect(s).toMatchObject({ kind: 'relocate', slot: 1, zone: 'low', overrides: null, move: { plantId: 'basil', from: 1, toZone: 'medium', existing: true } })
    expect(s?.text).toMatch(/^Move the Basil already in pod 1 to pod \d+ \(its ideal medium zone\), then Arugula fits in pod 1 \(low\)\.$/)
  })

  it('does not suggest moving pinned pods or plants it cannot identify', () => {
    const low = [1, 2, 3, 28, 29, 30].filter(n => slotAt('home', n)?.zone === 'low')
    expect(low).toHaveLength(6)
    const r = planLayout({ model: 'home', plants: [{ plantId: 'arugula', count: 1 }, { plantId: 'basil', count: 1 }], occupied: Object.fromEntries(low.slice(1).map(n => [n, 'unknown:Weed'])), overrides: { pins: [{ slot: low[0] as number, plantId: 'basil' }] } })
    expect(r.unplaced).toMatchObject([{ plantId: 'arugula', blocking: expect.arrayContaining([{ slot: low[1], zone: 'low', plantId: 'unknown:Weed', plantName: 'Weed', existing: true }]) }])
    expect(r.suggestions.filter(s => s.kind === 'relocate')).toEqual([])
  })

  it('puts a herb one zone brighter, ok there, when its own zone is full', () => {
    // Six low pods; oregano wants seven of them.
    const r = planLayout({ model: 'home', plants: [{ plantId: 'oregano', count: 7 }] })
    expect(r.unplaced).toEqual([])
    expect(r.suggestions).toEqual([])
    expect(r.assignments.filter(a => a.slotZone === 'medium')).toMatchObject([{ plantId: 'oregano', fallback: 1, shift: 'higher', fit: 'ok', reason: 'ok here — medium light suits it too (ideal low)' }])
  })

  it('offers a herb a zone brighter than it tolerates when those are full, and the overrides carry it out', () => {
    const occupied = Object.fromEntries(slots('home').filter(x => x.zone === 'medium').map(x => [x.slot, 'kale']))
    const plants = [{ plantId: 'oregano', count: 7 }]
    const r = planLayout({ model: 'home', plants, occupied })
    expect(r.unplaced).toMatchObject([{ plantId: 'oregano', code: 'no_space', zones: ['low', 'medium'] }])
    expect(r.suggestions).toHaveLength(1)
    const s = r.suggestions[0]
    expect(s).toMatchObject({ kind: 'allow_higher', plantId: 'oregano', zone: 'high', move: null, overrides: { allowedZones: { oregano: ['low', 'medium', 'high'] } } })
    expect(s?.text).toBe('Allow Oregano in the high zone too (12 free) — more light than its ideal low zone; herbs take more light without harm.')
    const again = planLayout({ model: 'home', plants, occupied, overrides: s?.overrides ?? undefined })
    expect(again.unplaced).toEqual([])
    expect(again.assignments.filter(a => a.slotZone === 'high')).toMatchObject([{ plantId: 'oregano', fallback: 2, fit: 'ok', reason: 'high zone, allowed for this plan (ideal low)' }])
  })

  it('never offers lettuces, leafy greens or vegetables more light: it makes them bolt', () => {
    for (const plantId of ['butterhead', 'kale', 'celery']) {
      const r = planLayout({ model: 'home', plants: [{ plantId, count: 13 }], overrides: { allowedZones: { [plantId]: ['medium'] } } })
      expect(r.unplaced, plantId).toHaveLength(1)
      expect(r.suggestions.map(s => s.kind), plantId).toEqual(['allow_lower'])
    }
  })
})

describe('caller overrides', () => {
  it('pins pods to slots, counted toward the plant’s pods; extra pins add pods', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 2 }, { plantId: 'kale', count: 1 }], overrides: { pins: [{ slot: 8, plantId: 'basil' }, { slot: 4, plantId: 'kale' }, { slot: 5, plantId: 'kale' }] } })
    expect(r.assignments.filter(a => a.plantId === 'basil')).toHaveLength(2)
    expect(r.assignments.find(a => a.slot === 8)).toMatchObject({ plantId: 'basil', slotZone: 'high', fallback: 1, fit: 'ok', reason: 'you placed it here — high light, ok for it (ideal medium)' })
    expect(r.assignments.filter(a => a.plantId === 'kale').map(a => a.slot)).toEqual([4, 5])
    expect(r.assignments.find(a => a.slot === 4)).toMatchObject({ fit: 'ideal', reason: 'you placed it here' })
  })

  it('flags only a pin outside the zones a plant tolerates or the plan allows', () => {
    const pins = [{ slot: 8, plantId: 'butterhead' }, { slot: 1, plantId: 'jalapeno' }]
    const r = planLayout({ model: 'home', plants: [], overrides: { pins } })
    expect(r.assignments.map(a => [a.slot, a.shift, a.fit, a.reason])).toEqual([
      [1, 'lower', 'outside', 'you placed it here — low light, outside the zones it does well in (ideal high)'],
      [8, 'higher', 'outside', 'you placed it here — high light, outside the zones it does well in (ideal medium)'],
    ])
    const allowed = planLayout({ model: 'home', plants: [], overrides: { pins, allowedZones: { butterhead: ['medium', 'high'] } } })
    expect(allowed.assignments.find(a => a.slot === 8)).toMatchObject({ fit: 'ok', reason: 'you placed it here — high light, ok for it (ideal medium)' })
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
    expect(low.assignments.map(a => [a.slotZone, a.fallback, a.reason])).toEqual(Array(2).fill(['low', 1, 'ok here — low light, one zone lower than its ideal medium, as Gardyn advises']))

    const one = planLayout({ model: 'home', plants: [{ plantId: 'basil', count: 13 }], overrides: { allowedZones: { basil: ['medium'] } } })
    expect(one.assignments.every(a => a.slotZone === 'medium' && a.reason === 'medium light zone')).toBe(true)
    expect(one.unplaced).toMatchObject([{ zones: ['medium'], reason: 'no free slot in the medium zone (medium 12/12 taken)' }])
    expect(one.suggestions).toMatchObject([
      { kind: 'allow_lower', zone: 'low', overrides: { allowedZones: { basil: ['medium', 'low'] } } },
      { kind: 'allow_higher', zone: 'high', overrides: { allowedZones: { basil: ['medium', 'high'] } } },
    ])
  })

  it('says which way a pod sits from its ideal zone: lower, higher, or not at all', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'oregano', count: 7 }, { plantId: 'jalapeno', count: 13 }], overrides: { allowedZones: { oregano: ['low', 'medium'] } } })
    const shifts = (id: string) => r.assignments.filter(a => a.plantId === id).map(a => [a.slotZone, a.fallback, a.shift])
    expect(shifts('oregano')).toEqual(expect.arrayContaining([['low', 0, null], ['medium', 1, 'higher']]))
    expect(shifts('oregano').filter(x => x[2] === 'higher')).toHaveLength(1)
    expect(shifts('jalapeno').filter(x => x[2] === 'lower')).toEqual([['medium', 1, 'lower']])
    expect(r.assignments.filter(a => a.fallback === 0).every(a => a.shift === null)).toBe(true)
  })

  it('drops the cucumber’s bottom-centre start when the caller sets its zones', () => {
    const r = planLayout({ model: 'home', plants: [{ plantId: 'cucumber', count: 1 }], overrides: { allowedZones: { cucumber: ['high'] } } })
    expect(r.assignments[0]?.slotZone).toBe('high')
  })

  it('pins nursery pods too', () => {
    const r = planLayout({ model: 'nursery', plants: [{ plantId: 'basil', count: 1 }], overrides: { pins: [{ slot: 7, plantId: 'basil' }] } })
    expect(r.assignments).toMatchObject([{ slot: 7, slotZone: null, fallback: 0, fit: 'ideal', reason: 'you placed it here' }])
  })

  it('echoes only overrides that say something', () => {
    expect(planLayout({ model: 'home', plants: [], overrides: {} }).overrides).toBeUndefined()
    expect(planLayout({ model: 'home', plants: [], overrides: { pins: [], allowedZones: {} } }).overrides).toBeUndefined()
  })
})
