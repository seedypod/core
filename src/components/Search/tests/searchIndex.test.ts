import { describe, expect, it } from 'vitest'
import { navItems } from '@/src/components/AppShell/navItems'
import { DOCS_BASE, isDocsIndex, type DocsIndex } from '../docsIndex'
import docsSnapshot from '../docsIndex.json'
import { buildDocsEntries, buildSearchEntries, createSearch } from '../searchIndex'

const live = {
  pods: [
    { slot: 5, plant: 'Cherry Tomato', status: 'attention', notes: 'leaf curl' },
    { slot: 6, plant: 'Genovese Basil', status: 'growing', notes: '' },
    { slot: 7, plant: null, status: 'empty', notes: '' },
  ],
  rules: [{ id: 3, name: 'Dim when hot', enabled: true, dryRun: false }, { id: 4, name: 'pH drifting up', enabled: true, dryRun: true }],
}
const top = (q: string) => createSearch(buildSearchEntries(live))(q, 5)

const snapshot = docsSnapshot as DocsIndex
const appEntries = buildSearchEntries(live)
const docsEntries = buildDocsEntries(snapshot)
const withDocs = createSearch([...appEntries, ...docsEntries])

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
    expect(top('database')[0]).toMatchObject({ title: 'Database', href: '/database' })
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

describe('docs snapshot', () => {
  const page = { path: '/a/', title: 'A', section: null, description: '', headings: [], keywords: '' }
  const valid: DocsIndex = { version: 1, generatedAt: '2026-11-01T00:00:00Z', base: DOCS_BASE, pages: [page] }

  it('matches the version 1 contract', () => {
    expect(isDocsIndex(docsSnapshot)).toBe(true)
    expect(snapshot.pages.length).toBeGreaterThan(0)
    expect(new Set(docsEntries.map(e => e.id)).size).toBe(docsEntries.length)
  })

  it.each([
    ['another version', { ...valid, version: 2 }],
    ['another origin', { ...valid, base: 'https://sleepypod.github.io' }],
    ['no pages', { ...valid, pages: [] }],
    ['a relative path', { ...valid, pages: [{ ...page, path: 'a/' }] }],
    ['a protocol-relative path', { ...valid, pages: [{ ...page, path: '//example.com/' }] }],
    ['a backslash path that leaves the docs origin', { ...valid, pages: [{ ...page, path: '/\\example.com/' }] }],
    ['a backslash path with an unparseable host', { ...valid, pages: [{ ...page, path: '/\\[x/' }] }],
    ['a page without a title', { ...valid, pages: [{ ...page, title: ' ' }] }],
    ['a malformed heading', { ...valid, pages: [{ ...page, headings: [{ title: 'x' }] }] }],
    ['a non-string section', { ...valid, pages: [{ ...page, section: 3 }] }],
    ['a repeated path', { ...valid, pages: [page, page] }],
    ['an array', [valid]],
    ['null', null],
  ])('rejects %s', (_, payload) => {
    expect(isDocsIndex(valid)).toBe(true)
    expect(isDocsIndex(payload)).toBe(false)
  })

  it('maps each page to an external docs entry under Docs and its section', () => {
    const debugging = docsEntries.find(e => e.id === 'docs:/core/debugging/')
    expect(debugging).toMatchObject({ title: 'Debugging', crumbs: ['Docs', 'User guide'], external: true, href: `${DOCS_BASE}/core/debugging/` })
    expect(docsEntries.find(e => e.id === 'docs:/getting-started/')?.crumbs).toEqual(['Docs'])
    for (const e of docsEntries) expect(e.href.startsWith(`${DOCS_BASE}/`)).toBe(true)
  })

  it('finds docs pages by title and by heading', () => {
    expect(withDocs('debugging')[0]).toMatchObject({ id: 'docs:/core/debugging/', external: true })
    expect(withDocs('raspberry pi os')[0]?.id).toBe('docs:/core/installation/')
    const byHeading = buildDocsEntries({ ...valid, pages: [{ ...page, title: 'Install', headings: [{ title: 'Flash the zeppelin', anchor: 'flash' }] }] })
    expect(createSearch([...appEntries, ...byHeading])('zeppelin')[0]?.id).toBe('docs:/a/')
  })

  it('keeps an app page, setting, plant or rule ahead of a docs page with the same name', () => {
    for (const e of appEntries) expect(withDocs(e.title)[0]?.external, e.title).toBeUndefined()
    for (const q of ['restore', 'sd card', 'hass', 'timezone', 'wifi', 'pump', 'tom', 'backup', 'calibration', 'home assistant']) {
      expect(withDocs(q)[0]?.external, q).toBeUndefined()
      expect(withDocs(q)[0]?.href, q).toBe(top(q)[0]?.href)
    }
  })
})
