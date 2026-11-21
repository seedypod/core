import { describe, expect, it } from 'vitest'
import { type Category, getPlant, plantFacts, PLANTS, sproutWindow, thinRule } from '../catalog'

describe('sproutWindow', () => {
  const of = (id: string) => {
    const p = getPlant(id)
    return p ? sproutWindow(p) : undefined
  }

  it('takes a plant\'s own window from the Plant Book, else from its help centre page', () => {
    expect(of('red-swiss-chard')).toEqual({ days: [7, 21], estimated: false })
    expect(of('buttercrunch')).toEqual({ days: [7, 21], estimated: false })
    expect(of('bulls-blood-beets')).toEqual({ days: [5, 10], estimated: false })
  })

  it('gives every vegetable a window of its own, and a custom one the category median', () => {
    const vegetables = PLANTS.filter(p => p.category === 'vegetable')
    expect(vegetables.length).toBeGreaterThan(0)
    expect(vegetables.every(p => sproutWindow(p)?.estimated === false)).toBe(true)
    expect(sproutWindow({ id: 'custom', category: 'vegetable' })).toEqual({ days: [5, 10], estimated: true })
  })

  it('falls back to the category median, flagged estimated, and null for a category with none', () => {
    expect(of('tokyo-bekana')).toEqual({ days: [7, 14], estimated: false })
    expect(of('bare-root-strawberries')).toEqual({ days: [10, 24], estimated: true })
    expect(PLANTS.every(p => sproutWindow(p) !== null)).toBe(true)
    expect(sproutWindow({ id: 'custom', category: 'mushroom' as Category })).toBeNull()
  })
})

describe('plantFacts', () => {
  const of = (id: string) => plantFacts(getPlant(id) as NonNullable<ReturnType<typeof getPlant>>)

  it('takes the thinning article\'s count over the plant\'s own page', () => {
    expect(of('basil')).toMatchObject({ thinTo: 3, thinEstimated: false, maturityDays: [68, 68], tempF: [70, 85], heightFt: '<1', latinName: 'Ocimum basilicum', article: '1783873' })
    expect(of('mammoth-basil').thinTo).toBe(1)
    expect(of('chamomile').thinTo).toBe('all')
    expect(of('watercress').thinTo).toBe(3)
    expect(of('bare-root-strawberries').thinTo).toBe('all')
  })

  it('gives every built-in plant a count and a page, and falls back to Gardyn\'s rule for its kind', () => {
    expect(PLANTS.every(p => plantFacts(p).article !== null)).toBe(true)
    expect(PLANTS.filter(p => plantFacts(p).thinEstimated).map(p => p.id)).toEqual(['sorrel'])
    expect(plantFacts({ id: 'custom', category: 'herb', size: 'normal' })).toMatchObject({ thinTo: 3, thinEstimated: true, article: null, maturityDays: null })
    expect([thinRule({ category: 'flower', size: 'large' }), thinRule({ category: 'flower', size: 'normal' }), thinRule({ category: 'fruiting', size: 'large' })]).toEqual([1, 3, 1])
  })

  it('fills the care level for plants the store doesn\'t sell', () => {
    expect(PLANTS.filter(p => p.careLevel === null).map(p => p.id)).toEqual(['sorrel'])
    expect(getPlant('mini-broccoli')?.careLevel).toBe('expert')
  })
})
