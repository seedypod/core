import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import type { CustomPlant } from '../../store/types'
import { BUILTIN, getPlant, makeCatalog, PLANTS } from '../catalog'
import { catalogFor, customToPlant, plantSlug, SUCCESSION_BY_CATEGORY } from '../custom'
import { bestSpots, planLayout, sowingPlan } from '../planner'

const okra: CustomPlant = { id: 'okra', name: 'Okra', category: 'fruiting', zone: 'high', harvestMonths: [2, 3], careLevel: 'intermediate', size: 'large', succession: 'fast-fruiting', source: 'user', createdAt: 't', updatedAt: 't' }
const shiso: CustomPlant = { ...okra, id: 'purple-shiso', name: 'Purple Shiso', category: 'herb', zone: 'low', harvestMonths: [1, 2], careLevel: null, size: 'normal', succession: 'long-greens-herbs' }

describe('custom plants', () => {
  it('slugs names the way the built-in ids are', () => {
    expect(plantSlug('  Jalapeño Pepper! ')).toBe('jalapeno-pepper')
    expect(plantSlug('Purple Shiso')).toBe('purple-shiso')
    expect(plantSlug('!!!')).toBe('')
  })

  it('become catalog plants marked custom; built-ins are not', () => {
    expect(customToPlant(okra)).toMatchObject({ id: 'okra', custom: true, inStore: false, harvestEstimated: false, yield: null, placement: null, harvestMonths: [2, 3] })
    expect(PLANTS.every(p => !p.custom)).toBe(true)
    expect(getPlant('basil')?.custom).toBe(false)
    expect(SUCCESSION_BY_CATEGORY.flower).toBe('flowers')
  })

  it('merge after the built-in plants for get, find and search', () => {
    const cat = makeCatalog([customToPlant(okra), customToPlant(shiso)])
    expect(cat.plants).toHaveLength(PLANTS.length + 2)
    expect(cat.get('okra')?.name).toBe('Okra')
    expect(cat.find('purple shiso')?.id).toBe('purple-shiso')
    expect(cat.find('Basil')?.custom).toBe(false)
    expect(cat.search({ custom: true }).map(p => p.id)).toEqual(['okra', 'purple-shiso'])
    expect(cat.search({ q: 'shiso', zone: 'low', category: 'herb' }).map(p => p.id)).toEqual(['purple-shiso'])
    expect(BUILTIN.get('okra')).toBeUndefined()
  })

  it('reads the unit’s custom plants from the store', () => {
    const store = new MemoryStore(30)
    expect(catalogFor(store).search({ custom: true })).toEqual([])
    store.customPlants.upsert(okra, 't')
    expect(catalogFor(store).get('okra')?.custom).toBe(true)
  })

  it('plan, rank and sow like built-in plants', () => {
    const cat = makeCatalog([customToPlant(okra), customToPlant(shiso)])
    expect(planLayout({ model: 'home', plants: [{ plantId: 'okra', count: 1 }] }).unplaced[0]?.code).toBe('not_in_catalog')
    const r = planLayout({ model: 'home', plants: [{ plantId: 'okra', count: 3 }, { plantId: 'purple-shiso', count: 7 }], occupied: { 2: 'okra' } }, cat)
    expect(r.assignments.filter(a => a.plantId === 'okra').every(a => a.slotZone === 'high')).toBe(true)
    expect(r.assignments.filter(a => a.plantId === 'purple-shiso')).toHaveLength(5)
    expect(r.unplaced).toHaveLength(2)
    expect(r.unplaced[0]).toMatchObject({ plantId: 'purple-shiso', plantName: 'Purple Shiso', blocking: expect.arrayContaining([expect.objectContaining({ slot: 2, plantName: 'Okra', existing: true })]) })
    expect(r.suggestions[0]).toMatchObject({ kind: 'relocate', move: { plantName: 'Okra', from: 2, toZone: 'high', existing: true } })

    expect(bestSpots('home', 'purple-shiso', {}, 3, cat).every(s => s.zone === 'low')).toBe(true)
    expect(bestSpots('home', 'purple-shiso')).toEqual([])
    const w = sowingPlan([{ plantId: 'okra', count: 2 }], new Date('2026-11-02T00:00:00Z'), 'staggered', cat)
    // fast-fruiting: 2 months (60 d) + 31 d
    expect(w.map(x => x.sowOn)).toEqual(['2026-11-02', '2027-02-01'])
  })
})
