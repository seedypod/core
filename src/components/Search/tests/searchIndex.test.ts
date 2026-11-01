import { describe, expect, it } from 'vitest'
import { navItems } from '@/src/components/AppShell/navItems'
import { buildSearchEntries, createSearch } from '../searchIndex'

const live = {
  pods: [
    { slot: 5, plant: 'Cherry Tomato', status: 'attention', notes: 'leaf curl' },
    { slot: 6, plant: 'Genovese Basil', status: 'growing', notes: '' },
    { slot: 7, plant: null, status: 'empty', notes: '' },
  ],
  rules: [{ id: 3, name: 'Dim when hot', enabled: true, dryRun: false }, { id: 4, name: 'pH drifting up', enabled: true, dryRun: true }],
}
const top = (q: string) => createSearch(buildSearchEntries(live))(q, 5)

describe('search index', () => {
  it('has every page, the Settings cards, planted pods and rules, with unique ids', () => {
    const entries = buildSearchEntries(live)
    for (const n of navItems) expect(entries.some(e => e.href === n.to)).toBe(true)
    expect(entries.filter(e => e.id.startsWith('pod:')).map(e => e.title)).toEqual(['Cherry Tomato', 'Genovese Basil'])
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length)
    expect(entries.every(e => e.description.length > 0)).toBe(true)
  })

  it('finds a setting by what people call it', () => {
    expect(top('restore')[0]).toMatchObject({ title: 'Backup', href: '/settings#backup', crumbs: ['Settings'] })
    expect(top('sd card')[0]?.title).toBe('Storage')
    expect(top('hass')[0]?.title).toBe('Home Assistant bridge')
    expect(top('timezone')[0]?.title).toBe('Unit')
    expect(top('wifi')[0]).toMatchObject({ title: 'Wi-Fi', href: '/wifi' })
    expect(top('Wi-Fi')[0]?.title).toBe('Wi-Fi')
  })

  it('finds pages, pods by plant and rules by name while typing', () => {
    expect(top('pump')[0]?.title).toBe('Water')
    expect(top('tom')[0]).toMatchObject({ title: 'Cherry Tomato', href: '/grow?pod=5', crumbs: ['Grow', 'Pod 5'], description: 'Needs attention · leaf curl' })
    expect(top('basil')[0]?.href).toBe('/grow?pod=6')
    expect(top('dim when')[0]).toMatchObject({ title: 'Dim when hot', href: '/autopilot', description: 'Armed' })
    expect(top('drifting')[0]?.description).toBe('Dry run')
  })

  it('returns nothing for an empty query or no match', () => {
    expect(top('   ')).toEqual([])
    expect(top('zzzz')).toEqual([])
  })
})
