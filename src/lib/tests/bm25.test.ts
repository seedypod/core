import { describe, expect, it } from 'vitest'
import { createBm25Index, tokenize } from '../bm25'

const FIELDS = { title: { weight: 3 }, body: { weight: 1 } }

describe('tokenize', () => {
  it('lowercases, folds diacritics and keeps the joined form of hyphenated words', () => {
    expect(tokenize('Wi-Fi Réseau  AUTO-off')).toEqual(['wi', 'fi', 'wifi', 'reseau', 'auto', 'off', 'autooff'])
  })
  it('returns nothing for whitespace and punctuation', () => {
    expect(tokenize('  — ,. ')).toEqual([])
  })
})

describe('createBm25Index', () => {
  it('returns nothing for an empty or unmatched query', () => {
    const index = createBm25Index([{ title: 'Network', body: 'internet' }], FIELDS)
    expect(index.search('')).toEqual([])
    expect(index.search('   ')).toEqual([])
    expect(index.search('zebra')).toEqual([])
  })

  it('boosts a title match over the same term in the body', () => {
    const index = createBm25Index([
      { title: 'Display', body: 'theme options' },
      { title: 'Theme', body: 'display options' },
    ], FIELDS)
    expect(index.search('theme').map(h => h.index)).toEqual([1, 0])
    expect(index.search('display').map(h => h.index)).toEqual([0, 1])
  })

  it('prefix-matches only the last query token, preferring an exact token', () => {
    const index = createBm25Index([
      { title: 'Calibration', body: '' },
      { title: 'Calib', body: '' },
      { title: 'Network', body: '' },
      { title: 'Timezone', body: 'network clock' },
    ], FIELDS)
    expect(index.search('calib').map(h => h.index)).toEqual([1, 0])
    expect(index.search('calibr').map(h => h.index)).toEqual([0])
    // "netw" is not the last token, so it has to match a whole word.
    expect(index.search('netw clock').map(h => h.index)).toEqual([3])
    expect(index.search('clock netw').map(h => h.index).sort()).toEqual([2, 3])
  })

  it('breaks score ties by indexing order', () => {
    const docs = [
      { title: 'Alpha', body: 'shared' },
      { title: 'Beta', body: 'shared' },
      { title: 'Gamma', body: 'shared' },
    ]
    const hits = createBm25Index(docs, FIELDS).search('shared')
    expect(hits.map(h => h.index)).toEqual([0, 1, 2])
    expect(new Set(hits.map(h => h.score)).size).toBe(1)
    const reversed = createBm25Index([...docs].reverse(), FIELDS).search('shared')
    expect(reversed.map(h => h.index)).toEqual([0, 1, 2])
  })

  it('weights rare terms higher, sums across query terms and applies the document boost', () => {
    const index = createBm25Index([
      { title: 'Pump', body: 'water' },
      { title: 'Prime', body: 'water air' },
      { title: 'Tank', body: 'water', boost: 0.5 },
    ], FIELDS)
    const [first, ...rest] = index.search('water air')
    expect(first.index).toBe(1)
    expect(rest.map(h => h.index)).toEqual([0, 2])
    expect(rest[0].score).toBeCloseTo(rest[1].score * 2)
    expect(index.search('water', 1)).toHaveLength(1)
  })

  it('normalises by field length and saturates repeated terms', () => {
    const index = createBm25Index([
      { title: 'LED night mode brightness window', body: '' },
      { title: 'LED', body: '' },
      { title: 'LED LED LED LED', body: '' },
    ], { title: { weight: 1, b: 0.75 }, body: { weight: 1 } })
    const scores = new Map(index.search('led').map(h => [h.index, h.score]))
    expect(scores.get(1)).toBeGreaterThan(scores.get(0) ?? 0)
    // Four occurrences score more than one, but far less than four times as much.
    expect(scores.get(2)).toBeGreaterThan(scores.get(0) ?? 0)
    expect(scores.get(2)).toBeLessThan((scores.get(1) ?? 0) * 2)
  })
})
