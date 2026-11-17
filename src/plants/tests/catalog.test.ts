import { describe, expect, it } from 'vitest'
import { type Category, getPlant, PLANTS, sproutWindow } from '../catalog'

describe('sproutWindow', () => {
  const of = (id: string) => {
    const p = getPlant(id)
    return p ? sproutWindow(p) : undefined
  }

  it('takes a plant\'s own window from the Plant Book, else from Iowa State\'s table', () => {
    expect(of('red-swiss-chard')).toEqual({ days: [7, 21], estimated: false })
    expect(of('buttercrunch')).toEqual({ days: [7, 14], estimated: false })
    expect(of('bulls-blood-beets')).toEqual({ days: [5, 8], estimated: false })
  })

  it('gives every vegetable a window of its own, and a custom one the category median', () => {
    const vegetables = PLANTS.filter(p => p.category === 'vegetable')
    expect(vegetables.length).toBeGreaterThan(0)
    expect(vegetables.every(p => sproutWindow(p)?.estimated === false)).toBe(true)
    expect(sproutWindow({ id: 'custom', category: 'vegetable' })).toEqual({ days: [4, 7], estimated: true })
  })

  it('falls back to the category median, flagged estimated, and null for a category with none', () => {
    expect(of('tokyo-bekana')).toEqual({ days: [6, 21], estimated: true })
    expect(PLANTS.every(p => sproutWindow(p) !== null)).toBe(true)
    expect(sproutWindow({ id: 'custom', category: 'mushroom' as Category })).toBeNull()
  })
})
