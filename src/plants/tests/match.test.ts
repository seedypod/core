import { describe, expect, it } from 'vitest'
import { getPlant, makeCatalog } from '../catalog'
import { customToPlant } from '../custom'
import { matchOrder, MATCH_THRESHOLD, parseLine, rankNames, words } from '../match'

describe('parseLine', () => {
  it.each([
    ['Genovese Basil x2', 'Genovese Basil', 2],
    ['Genovese Basil ×2', 'Genovese Basil', 2],
    ['3 × Butterhead Lettuce yCube', 'Butterhead Lettuce yCube', 3],
    ['2 Mint', 'Mint', 2],
    ['- Cherry Tomatoes (2)', 'Cherry Tomatoes', 2],
    ['Thai Basil - Qty: 4', 'Thai Basil', 4],
    ['1. Jalapeño 2 pods $9.99', 'Jalapeño', 2],
    ['Kale', 'Kale', 1],
    ['Kale x0', 'Kale', 1],
  ])('%s', (line, name, count) => {
    expect(parseLine(line)).toEqual({ name, count })
  })
})

describe('words', () => {
  it('folds case, accents, plurals and order noise', () => {
    expect(words('Jalapeño Peppers yCubes')).toEqual(['jalapeno', 'pepper'])
    expect(words('Strawberries, Tomatoes & Radishes')).toEqual(['strawberry', 'tomato', 'radish'])
    expect(words('Bull\'s Blood Beets 2 pack')).toEqual(['bull', 'blood', 'beet'])
    expect(words('Grass')).toEqual(['grass'])
  })
})

describe('rankNames', () => {
  it('scores exact names 1, synonyms 0.95 and partial names by their distinctive words', () => {
    expect(rankNames('Mint')[0]).toEqual({ plantId: 'mint', plantName: 'Mint', confidence: 1 })
    expect(rankNames('Genovese Basil')[0]).toMatchObject({ plantId: 'basil', confidence: 0.95 })
    const butterhead = rankNames('Butterhead Lettuce')
    expect(butterhead[0]?.plantId).toBe('butterhead')
    expect(butterhead[0]?.confidence).toBeGreaterThan(0.7)
    expect(butterhead.find(c => c.plantId === 'endive-lettuce')?.confidence).toBeLessThan(MATCH_THRESHOLD)
    // A typo still finds it, with less confidence.
    expect(rankNames('Butterhed')[0]).toMatchObject({ plantId: 'butterhead', confidence: 0.8 })
    expect(rankNames('Romaine Lettuce')[0]?.plantId).toBe('romaine')
    expect(rankNames('...')).toEqual([])
  })

  it('maps every synonym to a plant that exists', () => {
    for (const name of ['sweet basil', 'thai basil', 'cherry tomatoes', 'parsley', 'coriander', 'scallions', 'tuscan kale', 'bibb lettuce', 'spinach', 'strawberries']) {
      const best = rankNames(name)[0]
      expect(best?.confidence, name).toBeGreaterThanOrEqual(0.95)
      expect(getPlant(best?.plantId ?? ''), name).toBeDefined()
    }
  })
})

describe('matchOrder', () => {
  it('matches lines, sums counts per plant, and returns what it could not place', () => {
    const r = matchOrder(['Genovese Basil x2', '3 × Butterhead Lettuce yCube', 'Basil', 'Dragonfruit x1', '$12.99', '', 'Swiss Chard'])
    expect(r.matched.map(m => [m.line, m.plantId, m.count])).toEqual([
      ['Genovese Basil x2', 'basil', 2],
      ['3 × Butterhead Lettuce yCube', 'butterhead', 3],
      ['Basil', 'basil', 1],
      ['Swiss Chard', 'red-swiss-chard', 1],
    ])
    expect(r.plants).toEqual([{ plantId: 'basil', count: 3 }, { plantId: 'butterhead', count: 3 }, { plantId: 'red-swiss-chard', count: 1 }])
    // Two chards are equally good: the other comes back as an alternative.
    expect(r.matched[3]?.alternatives.map(a => a.plantId)).toEqual(['yellow-swiss-chard'])
    expect(r.matched[0]?.alternatives).toEqual([])
    expect(r.unmatched).toEqual([{ line: 'Dragonfruit x1', name: 'Dragonfruit', count: 1, suggestions: [] }])
    expect(r.skipped).toEqual(['$12.99'])
  })

  it('splits a pasted block, suggests near names, and caps a plant at 30 pods', () => {
    const r = matchOrder(['Mint x20; Mint x20\nPurple thing, Oregano'])
    expect(r.plants).toEqual([{ plantId: 'mint', count: 30 }, { plantId: 'oregano', count: 1 }])
    expect(r.unmatched).toHaveLength(1)
    expect(r.unmatched[0]).toMatchObject({ line: 'Purple thing', name: 'Purple thing' })
    expect(r.unmatched[0]?.suggestions.length).toBeGreaterThan(0)
    expect(r.unmatched[0]?.suggestions.every(s => s.plantName.startsWith('Purple'))).toBe(true)
  })

  it('matches custom plants in the catalog it is given', () => {
    const lovage = customToPlant({ id: 'lovage', name: 'Lovage', category: 'herb', zone: 'medium', harvestMonths: [2, 3], careLevel: null, size: 'normal', succession: 'long-greens-herbs', source: 'user', createdAt: 't', updatedAt: 't' })
    expect(matchOrder(['Lovage x2']).unmatched).toHaveLength(1)
    expect(matchOrder(['Lovage x2'], makeCatalog([lovage])).plants).toEqual([{ plantId: 'lovage', count: 2 }])
  })
})
