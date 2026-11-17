// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalysisPage } from '../AnalysisPage'
import type * as LabelPodsModule from '../LabelPods'

const { data, calls, invalidate, demo } = vi.hoisted(() => ({
  demo: { on: false },
  data: new Map<string, unknown>(),
  calls: { setPrimary: vi.fn(), rerun: vi.fn(), setRegions: vi.fn(), compare: vi.fn(), capture: vi.fn(), summary: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/demo/mode', () => ({ isDemo: () => demo.on }))
// The tagger has its own tests (labelPods.test.tsx); here it only has to be on the page with the pod boxes.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, ...rest }: { children: ReactNode, to: string, search?: { pod: number } }) => <a href={search ? `${to}?pod=${search.pod}` : to} {...rest}>{children}</a>,
}))
vi.mock('../LabelPods', async orig => ({ ...(await orig<typeof LabelPodsModule>()), LabelPods: ({ boxes, onEditBoxes, boxesOff }: { boxes: (c: 'upper' | 'lower') => Record<number, unknown>, onEditBoxes: () => void, boxesOff: Array<{ slot: number }> }) => (
  <div>
    <span data-testid="label-pods-stub">{Object.keys(boxes('lower')).join(',')}</span>
    <span data-testid="boxes-off-stub">{boxesOff.map(b => b.slot).join(',')}</span>
    <button type="button" onClick={onEditBoxes}>stub move boxes</button>
  </div>
) }))

vi.mock('../LeafCover', () => ({ LeafCover: () => <div data-testid="leaf-cover-stub" /> }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: (input?: unknown, opts?: { enabled?: boolean }) => {
    if (name === 'compare') calls.compare(input)
    if (name === 'capture') calls.capture(input, opts)
    if (name === 'summary') calls.summary(input)
    // Per camera or per capture when a test sets it so, else one answer for every input.
    const by = name === 'frames' ? (input as { camera: string }).camera : ['capture', 'suggestions', 'labels'].includes(name) ? (input as { captureId: string }).captureId : name === 'compare' ? (input as { metric: string }).metric : name === 'still' ? (input as { id: string }).id : null
    const answer = by !== null && data.has(`${name}:${by}`) ? data.get(`${name}:${by}`) : data.get(name)
    return { data: opts?.enabled === false ? undefined : answer }
  } })
  const mutation = (name: 'setPrimary' | 'rerun' | 'setRegions') => ({ useMutation: (o?: { onSuccess?: () => void }) => ({
    isPending: false,
    error: data.get(`${name}Error`) ?? null,
    mutate: (input: unknown) => {
      calls[name](input)
      o?.onSuccess?.()
    },
    mutateAsync: async (input: unknown) => {
      calls[name](input)
      if (data.has(`${name}Error`)) throw data.get(`${name}Error`)
      o?.onSuccess?.()
    },
  }) })
  return {
    apiBase: () => '',
    trpc: {
      useUtils: () => ({ vision: { invalidate } }),
      vision: { analyzers: query('analyzers'), status: query('status'), podTrends: query('podTrends'), allPodSeries: query('allPodSeries'), compare: query('compare'), capture: query('capture'), regions: query('regions'), suggestions: query('suggestions'), labels: query('labels'), labelStats: query('labelStats'), podCodes: query('podCodes'), boxesOff: query('boxesOff'), agreement: query('agreement'), podLabels: query('podLabels'), setPrimary: mutation('setPrimary'), rerun: mutation('rerun'), setRegions: mutation('setRegions') },
      camera: { list: query('frames'), get: query('still') },
      grow: { pods: query('pods'), current: query('current') },
      datasets: { summary: query('summary') },
    },
  }
})

const metric = { name: 'green_fraction', label: 'Green area', description: '' }
const base = { metrics: [metric], runsOn: ['device'], source: 'device', rows: 30, captures: 2, firstTs: '2026-01-01T00:00:00Z', lastTs: '2026-01-02T00:00:00Z' }
const row = (analyzer: string, slot: number, value: number) => ({ captureId: slot > 15 ? 'lower-1' : 'upper-1', ts: '2026-01-02T00:00:00Z', camera: slot > 15 ? 'lower' : 'upper', analyzer, version: 1, source: 'device', slot, metric: 'green_fraction', value, detail: null, artifact: null })
const frame = (camera: string) => ({ id: `${camera}-1`, camera, ts: '2026-01-02T00:00:00Z', path: 'x.jpg', bytes: 1, url: `/api/captures/${camera}-1.jpg` })
/** Pod rows of the table, without the per-camera headings. */

beforeEach(() => {
  data.clear()
  demo.on = false
  for (const f of Object.values(calls)) f.mockReset()
  data.set('analyzers', [
    { ...base, id: 'green-threshold', version: 1, label: 'Fixed green threshold', description: 'Fixed cut-off.', primary: true },
    { ...base, id: 'exg-otsu', version: 1, label: 'Excess green + Otsu', description: 'Per-image threshold.', primary: false },
    { ...base, id: 'leaf-unet', version: 2, label: 'leaf-unet', description: 'Results posted by an off-device worker.', primary: false, source: 'remote', runsOn: ['remote'], metrics: [], captures: 0, rows: 0 },
  ])
  data.set('status', { running: null, waiting: [], dropped: 0, failed: 0, backfill: null })
  data.set('compare:green_fraction', [
    { analyzer: 'green-threshold', version: 1, source: 'device', points: [{ ts: '2026-01-01T00:00:00Z', value: 0.2, captureId: 'a' }, { ts: '2026-01-02T00:00:00Z', value: 0.4, captureId: 'b' }] },
    { analyzer: 'exg-otsu', version: 1, source: 'device', points: [{ ts: '2026-01-02T00:00:00Z', value: 0.52, captureId: 'b' }] },
  ])
  data.set('frames:upper', [frame('upper')])
  data.set('frames:lower', [frame('lower')])
  data.set('capture:upper-1', [row('exg-otsu', 1, 0.45), row('green-threshold', 1, 0.4), row('green-threshold', 2, 0.1), { ...row('exg-otsu', 2, 3), metric: 'leaf_count' }])
  data.set('capture:lower-1', [row('green-threshold', 16, 0.2), row('exg-otsu', 16, 0.25)])
  data.set('pods', [{ slot: 1, plant: 'Swiss Chard' }])
})

const open = (tab: 'Pods' | 'Teach' | 'Methods') => fireEvent.click(screen.getByRole('tab', { name: tab }))
const openExport = () => {
  open('Teach')
  fireEvent.click(screen.getByText('Export dataset'))
}
afterEach(cleanup)

describe('AnalysisPage', () => {
  it('lists every method version as a row, the primary picked by its radio', () => {
    render(<AnalysisPage />)
    open('Methods')
    const group = screen.getByRole('group', { name: 'Primary method' })
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map(r => r.closest('fieldset'))).toEqual([group, group, group])
    expect(radios.map(r => r.checked)).toEqual([true, false, false])
    expect(screen.getByRole('radio', { name: 'green-threshold@1 Fixed green threshold', description: 'Fixed cut-off.' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'leaf-unet@2 leaf-unet' })).toBeTruthy()
    expect(screen.getAllByText('2 captures')).toHaveLength(2)
    expect(screen.getByText('No results yet · remote')).toBeTruthy()
    // Re-run is offered only for analysers that run here.
    expect(screen.getAllByRole('button', { name: /^Re-run/ }).map(b => b.getAttribute('aria-label'))).toEqual(['Re-run green-threshold@1', 'Re-run exg-otsu@1'])
  })

  it('makes an analyser primary by its radio and starts a re-run', () => {
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('radio', { name: 'exg-otsu@1 Excess green + Otsu' }))
    expect(calls.setPrimary).toHaveBeenCalledWith({ analyzer: 'exg-otsu' })
    fireEvent.click(screen.getByRole('button', { name: 'Re-run exg-otsu@1' }))
    expect(calls.rerun).toHaveBeenCalledWith({ analyzer: 'exg-otsu', limit: 2000 })
    expect(invalidate).toHaveBeenCalled()
  })

  it('holds re-runs while one is running', () => {
    data.set('status', { running: null, waiting: [], dropped: 0, failed: 0, backfill: { analyzer: 'exg-otsu', done: 3, total: 10 } })
    render(<AnalysisPage />)
    open('Methods')
    expect(screen.getAllByRole('button', { name: /^Re-run/ }).every(b => (b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('compares the picked pod across analysers, and goes back to all pods', () => {
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('button', { name: 'Pod 1, Swiss Chard' }))
    expect(screen.getByText('One pod over time')).toBeTruthy()
    expect(screen.getByText('Pod 1 · Swiss Chard')).toBeTruthy()
    expect(screen.queryByLabelText('Pod')).toBeNull()
    expect(screen.getByRole('img', { name: 'green-threshold@1, exg-otsu@1' })).toBeTruthy()
    expect(screen.getByText('52%')).toBeTruthy()
    expect(calls.compare).toHaveBeenCalledWith({ slot: 1, metric: 'green_fraction', limit: 200 })
    expect(calls.compare).toHaveBeenLastCalledWith({ slot: 1, metric: 'pod_state', limit: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'All pods' }))
    expect(screen.getByText('All pods over time')).toBeTruthy()
  })

  it('shows a learned analyser\'s latest pod state for the chosen pod, and can\'t make it primary', () => {
    data.set('analyzers', [...(data.get('analyzers') as object[]), { ...base, id: 'pod-state', version: 1, label: 'Pod state (learned)', description: 'A small CNN.', primary: false, metrics: [{ name: 'pod_state', label: 'Pod state', description: '' }] }])
    data.set('compare:pod_state', [{ analyzer: 'pod-state', version: 1, source: 'device', points: [{ ts: '2026-01-02T00:00:00Z', value: 1, captureId: 'b' }] }])
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('button', { name: 'Pod 1, Swiss Chard' }))
    expect(screen.getByText('sprouted')).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'pod-state@1 Pod state (learned)' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: 'exg-otsu@1 Excess green + Otsu' }) as HTMLInputElement).disabled).toBe(false)
  })

  it('shows the pod itself: its crop from the newest photo, and photos across the chart', () => {
    data.set('compare:green_fraction', [
      { analyzer: 'green-threshold', version: 1, source: 'device', points: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((captureId, i) => ({ ts: `2026-01-0${i + 1}T00:00:00Z`, value: 0.1, captureId })) },
      { analyzer: 'exg-otsu', version: 1, source: 'device', points: [{ ts: '2026-01-04T00:00:00Z', value: 0.1, captureId: 'd' }] },
    ])
    for (const id of ['a', 'd', 'g']) data.set(`still:${id}`, { id, camera: 'upper', ts: '', path: `${id}.jpg`, bytes: 1, url: `/api/captures/${id}.jpg` })
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('button', { name: 'Pod 1, Swiss Chard' }))
    // The upper camera's newest still, scaled so pod 1's box fills the tile.
    const latest = screen.getAllByAltText('Pod 1 at 2026-01-02T00:00:00Z')[0] as HTMLImageElement
    expect(latest.getAttribute('src')).toBe('/api/captures/upper-1.jpg')
    expect(latest.style.width).not.toBe('')
    // Five of the seven photos, evenly from the first to the last; a pruned one says so.
    const strip = screen.getByTestId('pod-strip')
    expect([...strip.querySelectorAll('img')].map(i => i.getAttribute('src'))).toEqual(['/api/captures/a.jpg', '/api/captures/d.jpg', '/api/captures/g.jpg'])
    expect(strip.querySelectorAll('figure')).toHaveLength(5)
    expect(strip.textContent).toContain('Pruned')
  })

  it('fits the pod\'s tile to its still once it loads, and says when there is no photo or no box', () => {
    data.set('frames:upper', [{ ...frame('upper'), path: 'data:image/jpeg;base64,AA' }])
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('button', { name: 'Pod 1, Swiss Chard' }))
    const img = screen.getAllByAltText('Pod 1 at 2026-01-02T00:00:00Z')[0] as HTMLImageElement
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AA')
    const tile = img.parentElement as HTMLElement
    const before = tile.style.aspectRatio
    Object.defineProperty(img, 'naturalWidth', { value: 1280 })
    Object.defineProperty(img, 'naturalHeight', { value: 720 })
    fireEvent.load(img)
    expect(tile.style.aspectRatio).not.toBe(before)
    cleanup()
    data.set('regions', [{ camera: 'upper', calibrated: true, removed: [1], regions: [] }])
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('button', { name: 'Pod 1, Swiss Chard' }))
    expect(screen.getAllByText('No box').length).toBeGreaterThan(0)
    cleanup()
    data.set('frames:upper', [])
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('button', { name: 'Pod 1, Swiss Chard' }))
    expect(screen.getAllByText('No photo').length).toBeGreaterThan(0)
  })

  it('reads the chart against the pod\'s record in one line', () => {
    data.set('pods', [{ slot: 1, plant: 'Swiss Chard', status: 'seeded', plantedAt: '2026-01-01', notes: '' }])
    data.set('compare:green_fraction', [
      { analyzer: 'exg-otsu', version: 1, source: 'device', points: [{ ts: '2026-01-01T00:00:00Z', value: 0.16, captureId: 'a' }, { ts: '2026-01-02T00:00:00Z', value: 0, captureId: 'b' }] },
      { analyzer: 'exg-otsu', version: 2, source: 'device', points: [{ ts: '2026-01-01T00:00:00Z', value: 0, captureId: 'a' }, { ts: '2026-01-02T00:00:00Z', value: 0.004, captureId: 'b' }] },
    ])
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.click(screen.getByRole('button', { name: 'Pod 1, Swiss Chard' }))
    expect(screen.getByText('exg-otsu@1 up to 16% on this seeded pod; exg-otsu@2 holds under 2%, as it should.')).toBeTruthy()
  })

  it('scores each method against the labels', () => {
    data.set('agreement', { pods: 171, analyzers: [
      { analyzer: 'green-threshold', version: 1, metric: 'green_fraction', agree: 99, total: 171 },
      { analyzer: 'exg-otsu', version: 1, metric: 'green_fraction', agree: 161, total: 171 },
    ] })
    render(<AnalysisPage />)
    open('Methods')
    expect(screen.getByText('171 labelled pods')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'green-threshold@1 agrees with labels on 58% of 171 pods' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'exg-otsu@1 agrees with labels on 94% of 171 pods' })).toBeTruthy()
    expect(screen.getByText('94%')).toBeTruthy()
    // A version with nothing scored on a labelled pod gets a dash, not 0 %.
    expect(screen.getByRole('img', { name: 'leaf-unet@2 has no readings on labelled pods' })).toBeTruthy()
    expect(screen.getByText(/empty or seeded pod reads under 2% and a sprouted, growing or ready pod reads 2% or more/)).toBeTruthy()
  })

  it('says how to start scoring methods with no labels yet', () => {
    data.set('agreement', { pods: 0, analyzers: [] })
    render(<AnalysisPage />)
    open('Methods')
    expect(screen.getByText('0 labelled pods')).toBeTruthy()
    expect(screen.getByText(/No labelled pods yet/)).toBeTruthy()
    expect(screen.queryByRole('img', { name: /agrees with labels/ })).toBeNull()
  })

  it('shows everything known about a pod on hover, and pins it on a click for Methods to chart', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-09T12:00:00Z'))
    data.set('pods', [{ slot: 1, plant: 'Cilantro', status: 'seeded', plantedAt: '2026-01-01', notes: 'pinned to pod 1 by the caller' }, { slot: 3, plant: null, status: 'empty', plantedAt: null, notes: '' }])
    data.set('podTrends', [{ slot: 1, green: 0.018, verdict: 'growing', slope: 0.01, samples: 48, recent: [0, 0, 0.01, 0.018] }])
    data.set('suggestions:upper-1', [{ slot: 1, label: 'sprouted', by: 'pod-state@1', confidence: 0.9, from: null }])
    render(<AnalysisPage />)
    expect(screen.queryByTestId('pod-card')).toBeNull()
    const hit = screen.getByRole('button', { name: 'Pod 1, Cilantro, sprouted, 2% leaf cover' })
    fireEvent.pointerEnter(hit)
    const card = screen.getByRole('dialog', { name: 'Pod 1' })
    expect(card.textContent).toContain('Cilantro')
    expect(card.textContent).toContain('Sprouted')
    expect(card.textContent).toContain('day 8 · sprouted')
    expect(card.textContent).toContain('leaf cover2% ↑ from 0%')
    expect(card.textContent).toContain('sproutsday 5–21 typical')
    expect(card.textContent).toContain('labelpod-state 90%')
    expect(card.textContent).toContain('Growing over the last 4 photos')
    expect(card.textContent).toContain('pinned to pod 1 by the caller')
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    fireEvent.pointerLeave(hit)
    expect(screen.queryByTestId('pod-card')).toBeNull()

    fireEvent.click(hit)
    expect(hit.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Pod 1' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open pod' }).getAttribute('href')).toBe('/grow?pod=1')
    // Hovering another pod shows it for a moment; leaving it brings the pinned one back.
    const other = screen.getByRole('button', { name: 'Pod 3, empty' })
    fireEvent.focus(other)
    expect(screen.getByRole('dialog', { name: 'Pod 3' }).textContent).toContain('Empty')
    fireEvent.blur(other)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('pod-card')).toBeNull()
    fireEvent.click(hit)
    fireEvent.click(hit)
    expect(screen.queryByTestId('pod-card')).toBeNull()
    // Methods charts the pod picked last.
    open('Methods')
    expect(screen.getByText('One pod over time')).toBeTruthy()
    expect(screen.getByText('Pod 1 · Cilantro')).toBeTruthy()
    expect(calls.compare).toHaveBeenLastCalledWith({ slot: 1, metric: 'pod_state', limit: 1 })
    vi.useRealTimers()
  })

  it('lets a pod\'s card reach past the photo\'s edge rather than cutting it off', () => {
    render(<AnalysisPage />)
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Pod 2, empty' }))
    const clipped: string[] = []
    for (let el = screen.getByRole('dialog', { name: 'Pod 2' }).parentElement; el && el.tagName !== 'FIGURE'; el = el.parentElement) {
      if (el.classList.contains('overflow-hidden')) clipped.push(el.className)
    }
    expect(clipped).toEqual([])
  })

  it('says a pod marked empty has no cover, and hides the pod targets while the boxes are edited', () => {
    const state = { ...row('pod-state', 1, 1), metric: 'pod_state', detail: { state: 'sprouted', confidence: 0.9, probabilities: { empty: 0, sprouted: 0.9, unhealthy: 0.06 } } }
    data.set('analyzers', [...(data.get('analyzers') as object[]), { ...base, id: 'pod-state', version: 1, label: 'Pod state (learned)', description: 'A small CNN.', primary: false, metrics: [{ name: 'pod_state', label: 'Pod state', description: '' }] }])
    data.set('capture:upper-1', [row('exg-otsu', 1, 0.02), row('green-threshold', 1, 0.018), state, row('green-threshold', 2, 0.1)])
    data.set('pods', [{ slot: 1, plant: 'Cilantro', status: 'seeded', plantedAt: '2026-01-01', notes: '' }, { slot: 2, plant: null, status: 'empty', plantedAt: null, notes: '' }])
    render(<AnalysisPage />)
    open('Teach')
    // The bounds' card lists every analyser's reading of the pod.
    fireEvent.pointerEnter(screen.getAllByRole('button', { name: 'Pod 1 details' })[0] as HTMLElement)
    const card = screen.getByRole('dialog', { name: 'Pod 1' })
    expect(card.textContent).toContain('Seeded · day')
    expect([...card.querySelectorAll('.font-mono.text-fg')].map(e => e.textContent)).toEqual(['2%', '2%', 'sprouted 90%'])
    expect(screen.queryByRole('link', { name: 'Open pod' })).toBeNull()
    fireEvent.pointerEnter(screen.getAllByRole('button', { name: 'Pod 2 details' })[0] as HTMLElement)
    expect(screen.getByRole('dialog', { name: 'Pod 2' }).textContent).toContain('Marked empty, so none of this counts as cover.')
    fireEvent.click(screen.getByText('Edit boxes'))
    expect(screen.queryByTestId('pod-hits')).toBeNull()
    expect(screen.queryByTestId('pod-card')).toBeNull()
  })

  it('takes the tagger to the pod boxes for a box that isn\'t on a pod', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    render(<AnalysisPage />)
    expect(screen.queryByText('Edit boxes')).toBeNull()
    open('Teach')
    expect(screen.getByText('Edit boxes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'stub move boxes' }))
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(scroll.mock.contexts[0]).toBe(document.getElementById('pod-bounds'))
    // Adjust boxes opens the editor, and asking again keeps the draft.
    const box = screen.getByRole('button', { name: 'Pod 1 box' })
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    const moved = box.style.left
    fireEvent.click(screen.getByRole('button', { name: 'stub move boxes' }))
    expect(screen.getByRole('button', { name: 'Pod 1 box' }).style.left).toBe(moved)
  })

  it('counts what waits on the grower on the Teach tab, seen from any tab', () => {
    const hint = (slot: number, label = 'empty') => ({ slot, label, by: 'carry', confidence: null, from: null })
    // Pod 2 is labelled already, and pod 30's box was removed: neither waits.
    data.set('suggestions:upper-1', [hint(1), hint(2), hint(3, 'seeded')])
    data.set('labels:upper-1', [{ slot: 2, label: 'empty' }])
    data.set('suggestions:lower-1', [hint(16), hint(30)])
    data.set('regions', [{ camera: 'lower', calibrated: true, removed: [30], regions: Array.from({ length: 14 }, (_, i) => ({ slot: 16 + i, x: 0, y: 0, w: 0.1, h: 0.1, moved: false })) }])
    data.set('podCodes', { available: true, pairs: [], pods: [{ slot: 1, confirmed: null }, { slot: 6, confirmed: 'Kale' }, { slot: 8, confirmed: null }] })
    data.set('boxesOff', [{ camera: 'lower', slot: 28, photos: 2 }])
    render(<AnalysisPage />)
    // 3 suggestions + 2 codes + 1 box.
    expect(screen.getByRole('tab', { name: 'Teach, 6 waiting' })).toBeTruthy()
    expect(screen.getByTestId('teach-count').textContent).toBe('6')
    fireEvent.click(screen.getByRole('tab', { name: /^Teach/ }))
    expect(screen.getByTestId('boxes-off-stub').textContent).toBe('28')
    fireEvent.click(screen.getByRole('tab', { name: 'Methods' }))
    expect(screen.getByRole('tab', { name: 'Teach, 6 waiting' })).toBeTruthy()
  })

  it('shows no count when nothing waits', () => {
    data.set('podCodes', { available: true, pairs: [], pods: [{ slot: 6, confirmed: 'Kale' }] })
    data.set('boxesOff', [])
    render(<AnalysisPage />)
    expect(screen.getByRole('tab', { name: 'Teach' })).toBeTruthy()
    expect(screen.queryByTestId('teach-count')).toBeNull()
  })

  it('says on Teach how many pods are labelled and how often each suggester was right', () => {
    data.set('labelStats', {
      counts: {},
      pods: 171,
      sources: { picked: 40, accepted: 120, corrected: 11 },
      suggesters: [{ by: 'carry', accepted: 82, corrected: 18, right: 0.82 }, { by: 'record', accepted: 3, corrected: 2, right: 0.6 }, { by: 'pod-state@2', accepted: 1, corrected: 0, right: 1 }],
      captures: [],
    })
    render(<AnalysisPage />)
    open('Methods')
    expect(screen.queryByTestId('teach-summary')).toBeNull()
    expect(screen.getByText('How leaf cover is measured from camera frames')).toBeTruthy()
    open('Teach')
    const summary = screen.getByTestId('teach-summary')
    expect(summary.textContent).toBe('171 pods labelled · carry 82% right · record 60% right · pod-state 100% right')
    expect(summary.getAttribute('title')).toBe('40 picked · 120 accepted · 11 corrected')
  })

  it('starts on every planted pod side by side, on one scale, and charts one when it is picked', () => {
    data.set('pods', [
      { slot: 6, plant: 'Cilantro', status: 'seeded', plantedAt: '2026-01-01', notes: '' },
      { slot: 1, plant: 'Chives', status: 'seeded', plantedAt: '2026-01-01', notes: '' },
      { slot: 9, plant: null, status: 'growing', plantedAt: null, notes: '' },
      { slot: 11, plant: null, status: 'empty', plantedAt: null, notes: '' },
    ])
    data.set('podTrends', [{ slot: 6, green: 0.018, verdict: 'growing', slope: 0.01, samples: 4, recent: [] }, { slot: 1, green: 0, verdict: 'unknown', slope: 0, samples: 1, recent: [] }])
    const pts = (...v: number[]) => v.map((green, i) => ({ ts: `2026-01-0${i + 1}T00:00:00Z`, green }))
    data.set('allPodSeries', [{ slot: 1, points: pts(0) }, { slot: 6, points: pts(0, 0.01, 0.018) }, { slot: 11, points: pts(0.5, 0.6) }])
    render(<AnalysisPage />)
    open('Methods')
    expect(screen.getByText('All pods over time')).toBeTruthy()
    const grid = screen.getByTestId('all-pods')
    expect([...grid.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))).toEqual(['Pod 1, Chives', 'Pod 6, Cilantro', 'Pod 9, unnamed'])
    const six = screen.getByRole('button', { name: 'Pod 6, Cilantro' })
    expect(six.textContent).toContain('2%')
    expect(six.textContent).toContain('Growing')
    expect(screen.getByRole('button', { name: 'Pod 1, Chives' }).textContent).toContain('No photos scored yet')
    expect(screen.getByRole('button', { name: 'Pod 9, unnamed' }).textContent).toContain('—No photos scored yetNo trend yet')
    // The empty pod's 60 % stays out of the scale.
    expect(screen.getByText(/all on one scale from 0 to 5%/)).toBeTruthy()
    fireEvent.click(six)
    expect(screen.getByText('One pod over time')).toBeTruthy()
    expect(calls.compare).toHaveBeenLastCalledWith({ slot: 6, metric: 'pod_state', limit: 1 })
  })

  it('says when no pods are planted', () => {
    data.set('pods', [{ slot: 1, plant: null, status: 'empty', plantedAt: null, notes: '' }])
    render(<AnalysisPage />)
    open('Methods')
    expect(screen.getByText('No pods are planted.')).toBeTruthy()
  })

  it('says when an on-device analyser is off, and offers no re-run', () => {
    data.set('analyzers', [{ ...base, id: 'pod-state', version: 1, label: 'Pod state (learned)', description: 'A small CNN.', primary: false, metrics: [], captures: 0, rows: 0, disabled: 'No weights file is installed, so this analyser is off.' }])
    render(<AnalysisPage />)
    open('Methods')
    expect(screen.getByText('Off. No weights file is installed, so this analyser is off.')).toBeTruthy()
    expect(screen.queryByText('Re-run')).toBeNull()
  })

  it('opens on Pods with both cameras\' stills, and switches them for the towers', () => {
    render(<AnalysisPage />)
    expect(screen.getByRole('tab', { name: 'Pods' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByAltText('upper camera at 2026-01-02T00:00:00Z')).toBeTruthy()
    expect(screen.getByAltText('lower camera at 2026-01-02T00:00:00Z')).toBeTruthy()
    expect(screen.queryByText('Export dataset')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))
    expect(screen.queryByAltText('upper camera at 2026-01-02T00:00:00Z')).toBeNull()
    expect(screen.getByAltText('lower camera at 2026-01-02T00:00:00Z')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Towers' }))
    expect(screen.getByTestId('leaf-cover-stub')).toBeTruthy()
    expect(screen.queryByAltText('lower camera at 2026-01-02T00:00:00Z')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Lower' })).toBeNull()
  })

  it('tags each pod with its plant and cover, coloured by its state, and flags a seeded pod past its sprouting window', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-23T12:00:00Z'))
    data.set('current', { cycle: null, day: 22 })
    data.set('pods', [
      { slot: 16, plant: 'Perpetual Spinach', status: 'seeded', plantedAt: '2026-01-15', notes: '' },
      { slot: 17, plant: null, status: 'empty', plantedAt: null, notes: '' },
      { slot: 21, plant: 'Red Swiss Chard', status: 'seeded', plantedAt: '2026-01-01', notes: '' },
      { slot: 22, plant: 'Pink Swiss Chard', status: 'growing', plantedAt: '2026-01-01', notes: '' },
    ])
    data.set('podTrends', [{ slot: 16, green: 0.01, verdict: 'growing', slope: 0.01, samples: 4, recent: [0, 0.01] }, { slot: 21, green: 0, verdict: 'unknown', slope: 0, samples: 1, recent: [0] }])
    data.set('labels:lower-1', [{ captureId: 'lower-1', ts: '2026-01-23T08:00:00Z', camera: 'lower', slot: 16, label: 'sprouted', labelledAt: '2026-01-23T09:00:00Z', plant: 'Perpetual Spinach', plantedAt: '2026-01-15', source: 'picked', suggested: null, suggestedBy: null, suggestedConfidence: null }])
    data.set('podCodes', { available: true, pairs: [], pods: [{ slot: 16, camera: 'lower', code: 'oo/h', confidence: 0.9, ts: '2026-01-23T08:00:00Z', confirmed: 'Perpetual Spinach', recorded: null, shared: null, guess: 'Perpetual Spinach', from: 'own', disagrees: false }] })
    render(<AnalysisPage />)
    expect(screen.getByText('Day 22 · 3 planted · 2 sprouted · 1 looks late')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))
    const boxes = screen.getByTestId('pod-boxes-lower')
    const tag = (slot: number) => boxes.querySelector(`[data-slot="${slot}"]`)?.nextElementSibling?.textContent
    expect(tag(16)).toBe('16 Spinach · 1%')
    expect(tag(21)).toBe('21 Chard · late?')
    expect(tag(17)).toBe('17')
    expect(boxes.querySelector('[data-slot="16"]')?.getAttribute('data-stage')).toBe('sprouted')
    expect(boxes.querySelector('[data-slot="21"]')?.getAttribute('data-late')).toBe('true')
    expect((boxes.querySelector('[data-slot="21"]') as HTMLElement).style.borderColor).toBe('var(--status-warn)')
    expect(boxes.querySelector('[data-slot="17"]')?.className).toContain('border-dashed')
    expect(screen.getByRole('button', { name: 'Pod 21, Red Swiss Chard, seeded, 0% leaf cover, sprouting late' })).toBeTruthy()

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Pod 16, Perpetual Spinach, sprouted, 1% leaf cover' }))
    const card = screen.getByRole('dialog', { name: 'Pod 16' })
    expect(card.textContent).toContain('day 8 · sprouted')
    expect(card.textContent).toMatch(/labelyou · /)
    expect(card.textContent).toContain('confirmed')
    expect(screen.getByLabelText('open, open, slanted bar, half, solid')).toBeTruthy()
    fireEvent.pointerLeave(screen.getByRole('button', { name: /^Pod 16,/ }))
    fireEvent.pointerEnter(screen.getByRole('button', { name: /^Pod 21,/ }))
    expect(screen.getByRole('dialog', { name: 'Pod 21' }).textContent).toContain('day 22 · late')
    vi.useRealTimers()
  })

  it('lists the planted pods beside the photo, reveals the empty ones, and pins a pod from its row', () => {
    data.set('pods', [
      { slot: 16, plant: 'Perpetual Spinach', status: 'seeded', plantedAt: null, notes: '' },
      { slot: 17, plant: null, status: 'empty', plantedAt: null, notes: '' },
      { slot: 18, plant: null, status: 'empty', plantedAt: null, notes: '' },
      { slot: 25, plant: 'Green Bok Choy', status: 'seeded', plantedAt: null, notes: '' },
    ])
    data.set('podTrends', [{ slot: 25, green: 0.004, verdict: 'unknown', slope: 0, samples: 1, recent: [] }])
    render(<AnalysisPage />)
    const list = screen.getByTestId('pod-list')
    expect(list.textContent).toContain('PLANTED · 2')
    const rows = () => [...list.querySelectorAll('button[aria-pressed]')].map(b => b.textContent)
    expect(rows()).toEqual(['16Perpetual Spinachseeded—', '25Green Bok Choyseeded0%'])
    fireEvent.click(screen.getByRole('button', { name: '+ 2 empty' }))
    expect(rows()).toHaveLength(4)
    expect(rows()[1]).toBe('17Empty')
    fireEvent.click(screen.getByRole('button', { name: 'Hide empty' }))
    const row = screen.getByRole('button', { name: /^25Green Bok Choy/ })
    fireEvent.click(row)
    expect(row.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^Pod 25,/ }).getAttribute('aria-pressed')).toBe('true')
    // Relabel takes the pinned pod to Teach.
    fireEvent.click(screen.getByRole('button', { name: 'Relabel' }))
    expect(screen.getByRole('tab', { name: 'Teach' }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens the tab a link asks for', () => {
    const { rerender } = render(<AnalysisPage tab="teach" />)
    expect(screen.getByRole('tab', { name: 'Teach' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('label-pods-stub')).toBeTruthy()
    rerender(<AnalysisPage tab="methods" />)
    expect(screen.getByRole('tab', { name: 'Methods' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('label-pods-stub')).toBeNull()
  })

  it('takes each still\'s own shape once it loads', () => {
    render(<AnalysisPage />)
    const img = screen.getByAltText('upper camera at 2026-01-02T00:00:00Z') as HTMLImageElement
    const box = img.parentElement as HTMLElement
    expect(box.style.aspectRatio).toBe(`${4 / 3} / 1`)
    Object.defineProperty(img, 'naturalWidth', { value: 1280 })
    Object.defineProperty(img, 'naturalHeight', { value: 720 })
    fireEvent.load(img)
    expect(box.style.aspectRatio).toBe(`${16 / 9} / 1`)
  })

  it('draws the bounds each pod is scored on over both stills, with the chosen analyser\'s reading', () => {
    data.set('pods', [{ slot: 2, plant: null, status: 'empty' }])
    render(<AnalysisPage />)
    expect(screen.queryByTestId('pod-bounds')).toBeNull()
    open('Teach')
    const [upper, lower] = screen.getAllByTestId('pod-bounds')
    expect(upper?.querySelectorAll('[data-slot]')).toHaveLength(15)
    const labels = [...(upper?.querySelectorAll('[data-slot]') ?? [])].map(s => s.textContent)
    expect(labels.slice(0, 3)).toEqual(['1 · 40%', '2', '3'])
    expect(lower?.querySelector('[data-slot]')?.textContent).toBe('16 · 20%')
    expect(screen.getByText(/dashed middle/)).toBeTruthy()
  })

  it('draws the unit\'s calibrated boxes, and says which cameras have them', () => {
    data.set('regions', [{ camera: 'upper', calibrated: true, regions: [{ slot: 1, x: 0.5, y: 0.25, w: 0.2, h: 0.1, moved: true }] }])
    render(<AnalysisPage />)
    open('Teach')
    const box = screen.getAllByTestId('pod-bounds')[0]?.querySelector('[data-slot="1"]') as HTMLElement
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['50%', '25%', '20%', '10%'])
    expect(screen.getByText('· calibrated boxes')).toBeTruthy()
    expect(screen.getByText('· measured boxes')).toBeTruthy()
  })

  it('edits the boxes by keyboard and saves each camera\'s', async () => {
    render(<AnalysisPage />)
    open('Teach')
    expect(screen.queryByRole('button', { name: 'Pod 1 box' })).toBeNull()
    fireEvent.click(screen.getByText('Edit boxes'))
    const box = screen.getByRole('button', { name: 'Pod 1 box' })
    const before = parseFloat(box.style.left)
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    expect(parseFloat(box.style.left)).toBeCloseTo(before + 0.5, 1)
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => fireEvent.click(screen.getByText('Save boxes')))
    expect(calls.setRegions).toHaveBeenCalledTimes(2)
    const [upper] = calls.setRegions.mock.calls[0] as [{ camera: string, regions: Array<{ slot: number, x: number }> }]
    expect(upper.camera).toBe('upper')
    expect(upper.regions).toHaveLength(15)
    expect(upper.regions[0]?.x).toBeCloseTo(before / 100 + 0.005, 4)
    expect(calls.setRegions.mock.calls[1]?.[0]).toMatchObject({ camera: 'lower' })
    expect(screen.getByText(/Saved. New photos use these boxes/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pod 1 box' })).toBeNull()
  })

  it('drags a box and its corner, and resets or drops a draft', () => {
    render(<AnalysisPage />)
    open('Teach')
    fireEvent.click(screen.getByText('Edit boxes'))
    const overlay = screen.getAllByTestId('pod-bounds')[0] as HTMLElement
    overlay.getBoundingClientRect = () => ({ width: 400, height: 300, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, toJSON: () => ({}) })
    const box = screen.getByRole('button', { name: 'Pod 2 box' })
    const left = parseFloat(box.style.left)
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(overlay, { clientX: 140, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(overlay, { pointerId: 1 })
    expect(parseFloat(box.style.left)).toBeCloseTo(left + 10, 1)
    // After the drag ends, moving the pointer changes nothing.
    fireEvent.pointerMove(overlay, { clientX: 300, clientY: 100, pointerId: 1 })
    expect(parseFloat(box.style.left)).toBeCloseTo(left + 10, 1)
    const width = parseFloat(box.style.width)
    fireEvent.pointerDown(box.querySelector('[data-handle]') as HTMLElement, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(overlay, { clientX: 20, clientY: 0, pointerId: 2 })
    fireEvent.pointerCancel(overlay, { pointerId: 2 })
    expect(parseFloat(box.style.width)).toBeCloseTo(width + 5, 1)
    fireEvent.click(screen.getByText('Reset to measured'))
    expect(parseFloat(screen.getByRole('button', { name: 'Pod 2 box' }).style.left)).toBeCloseTo(left, 1)
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByRole('button', { name: 'Pod 2 box' })).toBeNull()
    expect(calls.setRegions).not.toHaveBeenCalled()
  })

  it('removes a box the camera can\'t see its pod in, puts it back, and saves the removal', async () => {
    data.set('regions', [{ camera: 'lower', calibrated: true, removed: [30], regions: Array.from({ length: 14 }, (_, i) => ({ slot: 16 + i, x: 0, y: 0, w: 0.1, h: 0.1, moved: false })) }])
    render(<AnalysisPage />)
    open('Teach')
    expect(screen.getByText('No box, not scored: 30')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove pod 28 box' })).toBeNull()
    fireEvent.click(screen.getByText('Edit boxes'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove pod 28 box' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Pod 27 box' }), { key: 'Delete' })
    expect(screen.queryByRole('button', { name: 'Pod 28 box' })).toBeNull()
    expect(screen.getByText('No box, not scored: 27, 28, 30')).toBeTruthy()
    fireEvent.click(screen.getByText('Put back 27'))
    expect(screen.getByRole('button', { name: 'Pod 27 box' })).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('Save boxes')))
    const lower = calls.setRegions.mock.calls.map(c => c[0] as { camera: string, regions: Array<{ slot: number }>, removed: number[] }).find(c => c.camera === 'lower')
    expect(lower?.removed).toEqual([28, 30])
    expect(lower?.regions.map(r => r.slot)).toContain(27)
  })

  it('shows why the boxes could not be saved', async () => {
    data.set('setRegionsError', new Error('pod 16 is not on the upper camera'))
    render(<AnalysisPage />)
    open('Teach')
    fireEvent.click(screen.getByText('Edit boxes'))
    await act(async () => fireEvent.click(screen.getByText('Save boxes')))
    expect(screen.getByRole('button', { name: 'Pod 1 box' })).toBeTruthy()
    expect(screen.queryByText(/Saved/)).toBeNull()
  })

  it('reports progress, failures and empty states', () => {
    data.set('status', { running: null, waiting: [], dropped: 0, failed: 2, backfill: { analyzer: 'exg-otsu', done: 3, total: 10 } })
    data.set('capture:upper-1', [])
    data.set('capture:lower-1', [])
    data.set('rerunError', new Error('already re-running exg-otsu'))
    render(<AnalysisPage />)
    expect(screen.getByText(/Re-running exg-otsu: 3 of 10 captures · 2 captures could not be scored/)).toBeTruthy()
    open('Methods')
    expect(screen.getByText('already re-running exg-otsu')).toBeTruthy()
    cleanup()
    data.set('frames:upper', [])
    data.set('frames:lower', [])
    data.set('analyzers', [])
    data.set('status', { running: 'upper-9', waiting: [], dropped: 0, failed: 0, backfill: null })
    render(<AnalysisPage />)
    expect(screen.getByText('Scoring upper-9')).toBeTruthy()
    expect(screen.getAllByText('No photos from this camera yet.')).toHaveLength(2)
    open('Methods')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(calls.capture).toHaveBeenLastCalledWith({ captureId: '' }, { enabled: false })
  })

  it('offers a dataset download for the chosen window, with or without photos', () => {
    data.set('summary', { from: '', to: '', images: true, captures: 12, analyses: 360, telemetry: 900, labels: 45, imageBytes: 2_400_000 })
    render(<AnalysisPage />)
    expect(screen.queryByText('Download')).toBeNull()
    openExport()
    expect(screen.getByText('12 photos · 360 results · 45 labels · 900 readings · about 2.4 MB')).toBeTruthy()
    expect(screen.getByTestId('label-pods-stub').textContent).toBe(Array.from({ length: 15 }, (_, i) => i + 16).join(','))
    const link = screen.getByText('Download').closest('a') as HTMLAnchorElement
    const q = new URL(link.href, 'http://unit').searchParams
    expect(q.get('images')).toBe('1')
    expect(Date.parse(q.get('to') ?? '') - Date.parse(q.get('from') ?? '')).toBe(30 * 86_400_000)
    fireEvent.click(screen.getByRole('tab', { name: '7 days' }))
    fireEvent.click(screen.getByLabelText('Include photos'))
    const q2 = new URL((screen.getByText('Download').closest('a') as HTMLAnchorElement).href, 'http://unit').searchParams
    expect(q2.get('images')).toBe('0')
    expect(Date.parse(q2.get('to') ?? '') - Date.parse(q2.get('from') ?? '')).toBe(7 * 86_400_000)
    expect(calls.summary).toHaveBeenLastCalledWith(expect.objectContaining({ images: false }))
  })

  it('explains that the demo cannot download', () => {
    demo.on = true
    render(<AnalysisPage />)
    openExport()
    expect(screen.getByText(/Downloads need a real unit/)).toBeTruthy()
    expect(screen.queryByText('Download')).toBeNull()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
