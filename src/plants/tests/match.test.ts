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

  it('places every line of a real Gardyn order, and leaves a variant the catalog lacks unmatched', () => {
    const order = ['Basil', 'Italian Parsley', 'Chives', 'Catnip', 'Cilantro', 'Green Bok Choy', 'Kale', 'Kale Lacinato', '2 Perpetual Spinach', 'Red Swiss Chard', 'Rosemary', 'Sweet Thai Basil', 'Thyme', 'Red Salad Bowl', 'Mint', 'Bunching Onions', 'Oregano', 'Pink Swiss Chard', 'Buttercrunch Lettuce']
      .map(l => (/^\d/.test(l) ? l.replace(/^(\d+) /, '$1 x ') : `1 x ${l}`))
      .join('\n\n')
    const r = matchOrder([order])
    expect(r.matched.map(m => [m.name, m.plantId, m.count, m.confidence])).toEqual([
      ['Basil', 'basil', 1, 1],
      ['Italian Parsley', 'italian-parsley', 1, 1],
      ['Chives', 'chives', 1, 1],
      ['Catnip', 'catnip', 1, 1],
      ['Cilantro', 'cilantro', 1, 1],
      ['Green Bok Choy', 'green-bok-choy', 1, 1],
      ['Kale', 'kale', 1, 1],
      ['Kale Lacinato', 'kale-lacinato', 1, 1],
      ['Perpetual Spinach', 'perpetual-spinach', 2, 1],
      ['Red Swiss Chard', 'red-swiss-chard', 1, 1],
      ['Rosemary', 'rosemary', 1, 1],
      ['Sweet Thai Basil', 'sweet-thai-basil', 1, 1],
      ['Thyme', 'thyme', 1, 1],
      ['Red Salad Bowl', 'red-salad-bowl', 1, 1],
      ['Mint', 'mint', 1, 1],
      ['Bunching Onions', 'bunching-onions', 1, 1],
      ['Oregano', 'oregano', 1, 1],
      ['Buttercrunch Lettuce', 'buttercrunch', 1, 0.76],
    ])
    expect(r.matched.every(m => m.alternatives.length === 0)).toBe(true)
    // Gardyn sells Red and Yellow Swiss Chard only: Pink is a variant to ask about or add, not a second Red.
    expect(r.unmatched).toHaveLength(1)
    expect(r.unmatched[0]).toMatchObject({ line: '1 x Pink Swiss Chard', name: 'Pink Swiss Chard', count: 1 })
    expect(r.unmatched[0]?.suggestions.slice(0, 2)).toEqual([
      { plantId: 'red-swiss-chard', plantName: 'Red Swiss Chard', confidence: 0.36, reason: 'colour differs (pink; catalog has red)' },
      { plantId: 'yellow-swiss-chard', plantName: 'Yellow Swiss Chard', confidence: 0.35, reason: 'colour differs (pink; catalog has yellow)' },
    ])
    expect(r.plants.find(p => p.plantId === 'red-swiss-chard')).toEqual({ plantId: 'red-swiss-chard', count: 1 })
    expect(r.plants.reduce((n, p) => n + p.count, 0)).toBe(19)
    expect(r.skipped).toEqual([])
  })

  it.each([
    ['Red Russian Kale', 'kale', 'colour differs (red); variety differs (russian)'],
    ['Purple Kale', 'kale', 'colour differs (purple)'],
    ['Green Swiss Chard', 'red-swiss-chard', 'colour differs (green; catalog has red)'],
    ['Green Salad Bowl', 'red-salad-bowl', 'colour differs (green; catalog has red)'],
    ['Red Butterhead', 'butterhead', 'colour differs (red)'],
    ['Purple Thai Basil', 'purple-basil', 'variety differs (thai)'],
    ['Rainbow Chard', 'red-swiss-chard', 'colour differs (rainbow; catalog has red)'],
  ])('never maps %s to a different variant', (line, plantId, reason) => {
    const r = matchOrder([line])
    expect(r.matched).toEqual([])
    expect(r.unmatched[0]?.suggestions[0]).toMatchObject({ plantId, reason })
    expect(r.unmatched[0]?.suggestions.every(s => s.confidence < MATCH_THRESHOLD)).toBe(true)
  })

  it.each([
    ['Kale', 'kale', 1],
    ['Kale Lacinato', 'kale-lacinato', 1],
    ['Lacinato Kale', 'kale-lacinato', 0.95],
    ['Basil', 'basil', 1],
    ['Genovese Basil', 'basil', 0.95],
    ['Thai Basil', 'sweet-thai-basil', 0.95],
    ['Sweet Thai Basil', 'sweet-thai-basil', 1],
    ['Buttercrunch', 'buttercrunch', 1],
    ['Buttercrunch Lettuce', 'buttercrunch', 0.76],
    ['Red Salad Bowl', 'red-salad-bowl', 1],
    ['Jalapeño Peppers', 'jalapeno', 0.79],
  ])('matches %s to its own variant only', (line, plantId, confidence) => {
    const [m] = matchOrder([line]).matched
    expect(m).toMatchObject({ plantId, confidence })
    expect(m?.reason).toBeUndefined()
    expect(m?.alternatives).toEqual([])
  })

  it('matches custom plants in the catalog it is given', () => {
    const lovage = customToPlant({ id: 'lovage', name: 'Lovage', category: 'herb', zone: 'medium', harvestMonths: [2, 3], careLevel: null, size: 'normal', succession: 'long-greens-herbs', source: 'user', createdAt: 't', updatedAt: 't' })
    expect(matchOrder(['Lovage x2']).unmatched).toHaveLength(1)
    expect(matchOrder(['Lovage x2'], makeCatalog([lovage])).plants).toEqual([{ plantId: 'lovage', count: 2 }])
  })
})
