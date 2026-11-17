import { describe, expect, it } from 'vitest'
import { getPlant, PLANTS } from '../catalog'
import { defaultTolerance, toleranceIn, zoneCost } from '../tolerance'

describe('zoneCost', () => {
  it('prices one zone lower cheapest, as Gardyn’s fallback, and a large plant moved up dearer', () => {
    expect(zoneCost('medium', 'medium', 'normal')).toBe(0)
    expect(zoneCost('high', 'medium', 'normal')).toBe(1)
    expect(zoneCost('low', 'medium', 'normal')).toBe(2)
    expect(zoneCost('high', 'low', 'normal')).toBe(3)
    expect(zoneCost('low', 'high', 'normal')).toBe(4)
    expect(zoneCost('medium', 'high', 'large')).toBe(3)
    expect(zoneCost('medium', 'low', 'large')).toBe(1)
  })
})

describe('defaultTolerance', () => {
  const zones = (id: string) => getPlant(id)?.tolerates
  it('gives every plant one zone lower, but fruiting plants nothing below medium', () => {
    expect(zones('jalapeno')).toEqual([{ zone: 'medium', cost: 1 }])
    expect(zones('butterhead')).toEqual([{ zone: 'low', cost: 1 }])
    expect(zones('kale')).toEqual([{ zone: 'low', cost: 1 }])
    expect(zones('arugula')).toEqual([])
    expect(defaultTolerance({ category: 'fruiting', zone: 'medium', size: 'normal' })).toEqual([])
  })

  it('gives herbs, flowers and legumes one zone higher too, after the one lower', () => {
    expect(zones('basil')).toEqual([{ zone: 'low', cost: 1 }, { zone: 'high', cost: 2 }])
    expect(zones('mint')).toEqual([{ zone: 'medium', cost: 2 }])
    expect(zones('viola')).toEqual([{ zone: 'low', cost: 1 }, { zone: 'high', cost: 2 }])
    expect(zones('peas')).toEqual([{ zone: 'low', cost: 1 }, { zone: 'high', cost: 3 }])
  })

  it('never strays more than one zone, for any built-in plant', () => {
    const rank = { high: 0, medium: 1, low: 2 }
    expect(PLANTS.every(p => p.tolerates.every(t => Math.abs(rank[t.zone] - rank[p.zone]) === 1))).toBe(true)
  })
})

describe('toleranceIn', () => {
  it('prices named zones, drops the ideal and repeats, cheapest first', () => {
    expect(toleranceIn(['high', 'low', 'medium', 'low'], { zone: 'medium', size: 'normal' })).toEqual([{ zone: 'low', cost: 1 }, { zone: 'high', cost: 2 }])
    expect(toleranceIn([], { zone: 'low', size: 'normal' })).toEqual([])
  })
})
