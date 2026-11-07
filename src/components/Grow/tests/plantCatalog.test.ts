import { describe, expect, it } from 'vitest'
import { CATALOG, lookup, words } from '../plants/catalog'

describe('plant catalog', () => {
  it('covers every yCube once', () => {
    expect(CATALOG).toHaveLength(73)
    expect(new Set(CATALOG.map(e => e.name)).size).toBe(CATALOG.length)
  })

  it('normalises names to plain singular words', () => {
    expect(words('Jalapeños')).toEqual(['jalapeno'])
    expect(words('Red Cherry Tomatoes')).toEqual(['red', 'cherry', 'tomato'])
    expect(words('Watercress')).toEqual(['watercress'])
  })

  it.each([
    ['Butterhead Lettuce', 'Butterhead'],
    ['Genovese Basil', 'Basil'],
    ['Red Russian Kale', 'Kale'],
    ['Cherry Tomato', 'Red Cherry Tomatoes'],
    ['Thai Basil', 'Sweet Thai Basil'],
    ['Swiss Chard', 'Red Swiss Chard'],
    ['Bok Choy', 'Green Bok Choy'],
    ['Jalapeño', 'Jalapeños'],
    ['peppers', 'Sweet Peppers'],
    ['beans', 'Green Beans'],
    ['Lavender', 'Lavender'],
  ])('matches %s to %s', (name, found) => {
    expect(lookup(name)?.name).toBe(found)
  })

  it('finds nothing for an empty or unrelated name, or one made only of qualifiers', () => {
    expect(lookup(null)).toBeNull()
    expect(lookup('')).toBeNull()
    expect(lookup('Mystery seed')).toBeNull()
    expect(lookup('Red lettuce')).toBeNull()
  })
})
