import { describe, expect, it } from 'vitest'
import { applyPreview, idToName, planChips, planMeta, plantNames, shortDate, type SavedPlan } from '../planSummary'

// The real unit's order: 18 plants, 20 pods, as match_order reads it.
const ORDER = ['basil', 'italian-parsley', 'chives', 'catnip', 'cilantro', 'green-bok-choy', 'kale', 'kale-lacinato', 'perpetual-spinach', 'red-swiss-chard', 'rosemary', 'sweet-thai-basil', 'thyme', 'red-salad-bowl', 'mint', 'bunching-onions', 'oregano', 'buttercrunch']
const twice = new Set(['perpetual-spinach', 'red-swiss-chard'])
const CATALOG = [
  { id: 'basil', name: 'Basil' }, { id: 'italian-parsley', name: 'Italian Parsley' }, { id: 'chives', name: 'Chives' },
  { id: 'catnip', name: 'Catnip' }, { id: 'cilantro', name: 'Cilantro' }, { id: 'green-bok-choy', name: 'Green Bok Choy' },
  { id: 'perpetual-spinach', name: 'Perpetual Spinach' }, { id: 'red-swiss-chard', name: 'Red Swiss Chard' },
  { id: 'purple-shiso', name: 'Purple Shiso' },
]

function plan(over: Partial<SavedPlan> = {}): SavedPlan {
  return {
    id: 'order', name: 'Spring order', model: 'home', appliedAt: null,
    request: ORDER.map(plantId => ({ plantId, count: twice.has(plantId) ? 2 : 1 })),
    layout: {
      assignments: [{ slot: 25, plantId: 'basil', plantName: 'Basil' }, { slot: 26, plantId: 'kale', plantName: 'Kale' }, { slot: 27, plantId: 'kale', plantName: 'Kale' }],
      unplaced: [{ plantId: 'buttercrunch', plantName: 'Buttercrunch' }],
    },
    createdAt: '2026-11-09T08:00:00Z',
    updatedAt: '2026-11-09T08:00:00Z',
    ...over,
  }
}

describe('plan card summary', () => {
  it('names plants from the catalog, custom ones included, then as the layout recorded them, never by id', () => {
    const p = plan({ request: [...plan().request, { plantId: 'purple-shiso', count: 1 }, { plantId: 'lemon-verbena', count: 1 }] })
    const names = plantNames(p, CATALOG)
    expect(names.get('italian-parsley')).toBe('Italian Parsley')
    expect(names.get('purple-shiso')).toBe('Purple Shiso')
    // Not in this catalog page, but the plan's own layout named it.
    expect(names.get('kale')).toBe('Kale')
    expect(names.get('buttercrunch')).toBe('Buttercrunch')
    // Nothing names it any more: its id in words.
    expect(names.get('lemon-verbena')).toBe('Lemon Verbena')
    expect([...names.values()].some(n => /[a-z]-[a-z]/.test(n))).toBe(false)
  })

  it('shows six chips with their counts and holds the rest back as "+N more"', () => {
    const p = plan({ request: [{ plantId: 'perpetual-spinach', count: 2 }, ...plan().request] })
    const { shown, hidden } = planChips(p, plantNames(p, CATALOG))
    expect(shown.map(c => c.name)).toEqual(['Perpetual Spinach', 'Basil', 'Italian Parsley', 'Chives', 'Catnip', 'Cilantro'])
    // The same plant asked for twice is one chip.
    expect(shown[0]).toEqual({ plantId: 'perpetual-spinach', name: 'Perpetual Spinach', count: 4 })
    expect(hidden).toHaveLength(12)
    expect(hidden.find(c => c.plantId === 'red-swiss-chard')?.count).toBe(2)
  })

  it('shows a seventh plant rather than "+1 more"', () => {
    const p = plan({ request: ORDER.slice(0, 7).map(plantId => ({ plantId, count: 1 })) })
    expect(planChips(p, plantNames(p, CATALOG))).toMatchObject({ hidden: [] })
    expect(planChips(p, plantNames(p, CATALOG)).shown).toHaveLength(7)
    const eight = plan({ request: ORDER.slice(0, 8).map(plantId => ({ plantId, count: 1 })) })
    expect(planChips(eight, plantNames(eight, CATALOG)).hidden).toHaveLength(2)
  })

  it('gives the model, pods placed of the tower, unplaced, and when it was saved or updated', () => {
    expect(planMeta(plan())).toEqual({ model: 'Gardyn Home', placed: 3, capacity: 30, unplaced: 1, when: { verb: 'Saved', at: '2026-11-09T08:00:00Z' } })
    expect(planMeta(plan({ model: 'studio', layout: { assignments: [], unplaced: [] }, updatedAt: '2026-11-10T09:00:00Z' }))).toEqual({ model: 'Gardyn Studio', placed: 0, capacity: 16, unplaced: 0, when: { verb: 'Updated', at: '2026-11-10T09:00:00Z' } })
    expect(planMeta(plan({ createdAt: undefined, updatedAt: undefined })).when).toBeNull()
  })

  it('previews applying as the server does it: due waves seeded now, later ones scheduled', () => {
    const sowing = [{ plantId: 'basil', sowOn: '2026-11-09' }, { plantId: 'kale', sowOn: '2026-11-09' }, { plantId: 'kale', sowOn: '2026-12-20' }]
    expect(applyPreview(plan({ sowing }), '2026-11-09')).toEqual({ now: 2, later: 1, nextSow: '2026-12-20' })
    // A pod with no wave of its own is sown today.
    expect(applyPreview(plan(), '2026-11-09')).toEqual({ now: 3, later: 0, nextSow: null })
  })

  it('writes ids and dates for people', () => {
    expect(idToName('italian-parsley')).toBe('Italian Parsley')
    expect(idToName('okra')).toBe('Okra')
    const now = new Date('2026-11-09T12:00:00Z')
    expect(shortDate('2026-12-20', now)).toBe(new Date('2026-12-20T00:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }))
    expect(shortDate('2025-03-01', now)).toContain('2025')
    expect(shortDate('2026-11-09T08:00:00Z', now)).not.toContain('2026')
  })
})
