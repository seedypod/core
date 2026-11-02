import { describe, expect, it } from 'vitest'
import { PLANT_ZONE_MAP, PLANT_ZONES, placement, type Placement, placementAdvice, plantLight, podLight, podZone, podZones, towerModel, ZONES } from '../lightZones'
import { CATALOG } from '../plants/catalog'
import { podPlaces } from '../towerLayout'

const tally = (podCount: number) => {
  const n = { high: 0, medium: 0, low: 0 }
  for (const z of podZones(podCount).values()) n[z]++
  return n
}

describe('light zones', () => {
  it('tells a Home from a Studio by its pod count', () => {
    expect(towerModel(30)).toBe('home')
    expect(towerModel(16)).toBe('studio')
  })

  it('gives a Home 12 high pods in the centre, 12 medium around them, and its top and bottom rows low', () => {
    expect(tally(30)).toEqual({ high: 12, medium: 12, low: 6 })
    expect([1, 2, 3, 28, 29, 30].map(s => podZone(30, s))).toEqual(Array(6).fill('low'))
    // The middle column is high from the third row to the third from the bottom.
    expect([8, 11, 14, 17, 20, 23].map(s => podZone(30, s))).toEqual(Array(6).fill('high'))
    expect([5, 26].map(s => podZone(30, s))).toEqual(['medium', 'medium'])
  })

  it('gives a Studio 5 high pods, its lower left and upper right low, and the rest medium', () => {
    expect(tally(16)).toEqual({ high: 5, medium: 9, low: 2 })
    expect(podZone(16, 15)).toBe('low')
    expect(podZone(16, 2)).toBe('low')
    expect(podZone(16, 1)).toBe('medium')
    expect(podZone(16, 16)).toBe('medium')
  })

  it('puts the outer columns\' high pods on the side leaning in to the centre', () => {
    for (const podCount of [30, 16]) {
      const places = podPlaces(podCount)
      const last = places.at(-1)?.column ?? 0
      for (const p of places.filter(p => podZone(podCount, p.slot) === 'high' && (p.column === 0 || p.column === last))) {
        expect(p.side).toBe(p.column === 0 ? 1 : -1)
      }
    }
  })

  it('has no zone for a slot off the tower', () => {
    expect(podZone(30, 31)).toBeNull()
    expect(podZone(30, 0)).toBeNull()
  })

  it('lists each plant in one zone, and every yCube in the catalog finds one', () => {
    const names = ZONES.flatMap(z => PLANT_ZONES[z].flatMap(g => g.plants))
    expect(new Set(names).size).toBe(names.length)
    expect(PLANT_ZONE_MAP.size).toBe(names.length)
    expect(CATALOG.filter(e => !plantLight(e.name)).map(e => e.name)).toEqual([])
  })

  it.each([
    ['Genovese Basil', 'Basil', 'medium'],
    ['Holy Basil', 'Holy Basil', 'high'],
    ['Thai Basil', 'Sweet Thai Basil', 'medium'],
    ['Cherry Tomatoes', 'Red Cherry Tomato', 'high'],
    ['Habanero Pepper', 'Peppers', 'high'],
    ['strawberry', 'Strawberries', 'high'],
    ['Jalapeños', 'Jalapeño', 'high'],
    ['Lemon Balm', 'Lemon Balm', 'low'],
    ['Red Russian Kale', 'Kale', 'medium'],
    ['Iceberg Lettuce', 'Iceberg', 'medium'],
  ])('finds the zone for %s through %s', (plant, name, zone) => {
    expect(plantLight(plant)).toMatchObject({ name, zone })
  })

  it('knows nothing of an unlisted or missing plant', () => {
    expect(plantLight('Mystery seed')).toBeNull()
    expect(plantLight(null)).toBeNull()
  })
})

describe('placement', () => {
  const empty = [1, 5, 13, 14, 26, 29]

  it('fits a plant in its own zone', () => {
    expect(placement(30, 5, 'Basil', empty)).toMatchObject({ pod: 'medium', fits: true, light: 'right', better: [] })
  })

  it('says a high-light plant in a low pod is too dim, and offers the free high pods', () => {
    const p = placement(30, 1, 'Cherry Tomato', empty)
    expect(p).toMatchObject({ pod: 'low', fits: false, light: 'too-dim', better: [13, 14] })
    expect(placementAdvice(p as Placement)).toBe('Red Cherry Tomato grows best in high light; this pod gets low. Free pods that suit it: 13, 14.')
  })

  it('says a low-light herb in a high pod gets more than it needs', () => {
    const p = placement(30, 14, 'Mint', empty)
    expect(p).toMatchObject({ light: 'too-bright', better: [1, 29] })
    expect(placementAdvice(p as Placement)).toBe('Mint grows best in low light; this pod gets high, more than it needs. Free pods that suit it: 1, 29.')
  })

  it('wants a cucumber at the bottom of a Home\'s middle column, and by its zone on a Studio', () => {
    expect(placement(30, 29, 'Cucumber', empty)?.fits).toBe(true)
    const high = placement(30, 14, 'Cucumbers', empty)
    expect(high).toMatchObject({ fits: false, light: 'right', better: [26, 29] })
    expect(placementAdvice(high as Placement)).toBe('Cucumber grows best in high light. Place it at the bottom of the middle column, so the vine grows upward into higher light as it matures. Free pods that suit it: 26, 29.')
    expect(placement(16, 5, 'Cucumber')).toMatchObject({ pod: 'high', fits: true })
  })

  it('has nothing to say for an unlisted plant or a slot off the tower', () => {
    expect(placement(30, 5, 'Mystery seed')).toBeNull()
    expect(placement(30, 40, 'Basil')).toBeNull()
  })

  it('gives a pod its zone, with advice only when its plant would do better elsewhere', () => {
    const pods = Array.from({ length: 30 }, (_, i) => ({ slot: i + 1, status: i === 13 ? 'empty' : 'growing', plant: i === 0 ? 'Cherry Tomato' : i === 4 ? 'Basil' : null }))
    expect(podLight(pods, 5)).toEqual({ zone: 'medium', advice: undefined })
    expect(podLight(pods, 1)?.advice).toBe('Red Cherry Tomato grows best in high light; this pod gets low. Free pods that suit it: 14.')
    // A plant being picked, before it's saved.
    expect(podLight(pods, 5, 'Mint')?.advice).toContain('Mint grows best in low light; this pod gets medium')
    expect(podLight(pods, 31)).toBeNull()
  })
})
