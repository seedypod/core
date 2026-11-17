// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalysisPage } from '../AnalysisPage'

const { data, calls, invalidate, demo } = vi.hoisted(() => ({
  demo: { on: false },
  data: new Map<string, unknown>(),
  calls: { setPrimary: vi.fn(), rerun: vi.fn(), setRegions: vi.fn(), compare: vi.fn(), capture: vi.fn(), summary: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/demo/mode', () => ({ isDemo: () => demo.on }))
// The tagger has its own tests (labelPods.test.tsx); here it only has to be on the page with the pod boxes.
vi.mock('../LabelPods', () => ({ LabelPods: ({ boxes, onEditBoxes }: { boxes: (c: 'upper' | 'lower') => Record<number, unknown>, onEditBoxes: () => void }) => (
  <div>
    <span data-testid="label-pods-stub">{Object.keys(boxes('lower')).join(',')}</span>
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
    const by = name === 'frames' ? (input as { camera: string }).camera : name === 'capture' ? (input as { captureId: string }).captureId : name === 'compare' ? (input as { metric: string }).metric : null
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
      vision: { analyzers: query('analyzers'), status: query('status'), podTrends: query('podTrends'), allPodSeries: query('allPodSeries'), compare: query('compare'), capture: query('capture'), regions: query('regions'), setPrimary: mutation('setPrimary'), rerun: mutation('rerun'), setRegions: mutation('setRegions') },
      camera: { list: query('frames') },
      grow: { pods: query('pods') },
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
  it('shows the primary analyser in one card and the others on request', () => {
    render(<AnalysisPage />)
    open('Methods')
    const picker = screen.getByLabelText('Analyser') as HTMLSelectElement
    expect([...picker.options].map(o => o.value)).toEqual(['green-threshold@1', 'exg-otsu@1', 'leaf-unet@2'])
    expect(picker.value).toBe('green-threshold@1')
    expect(screen.getByText('Fixed green threshold')).toBeTruthy()
    expect(screen.getAllByText('PRIMARY')).toHaveLength(1)
    expect(screen.getByText('green-threshold@1 · on device')).toBeTruthy()
    expect(screen.getByText('2 captures · 30 results')).toBeTruthy()
    expect(screen.queryByText('Make primary')).toBeNull()
    expect(screen.getByText('Re-run')).toBeTruthy()
    fireEvent.change(picker, { target: { value: 'leaf-unet@2' } })
    expect(screen.getByText('leaf-unet@2 · remote')).toBeTruthy()
    expect(screen.getByText('No results yet')).toBeTruthy()
    expect(screen.queryByText('PRIMARY')).toBeNull()
    // Re-run is offered only for analysers that run here.
    expect(screen.queryByText('Re-run')).toBeNull()
  })

  it('makes an analyser primary and starts a re-run', () => {
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.change(screen.getByLabelText('Analyser'), { target: { value: 'exg-otsu@1' } })
    fireEvent.click(screen.getByText('Make primary'))
    expect(calls.setPrimary).toHaveBeenCalledWith({ analyzer: 'exg-otsu' })
    fireEvent.click(screen.getByText('Re-run'))
    expect(calls.rerun).toHaveBeenCalledWith({ analyzer: 'exg-otsu', limit: 2000 })
    expect(invalidate).toHaveBeenCalled()
  })

  it('compares the chosen pod across analysers', () => {
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.change(screen.getByLabelText('Pod'), { target: { value: '1' } })
    expect(screen.getByText('One pod over time')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'green-threshold@1, exg-otsu@1' })).toBeTruthy()
    expect(screen.getByText('52%')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Pod'), { target: { value: '7' } })
    expect(calls.compare).toHaveBeenCalledWith({ slot: 7, metric: 'green_fraction', limit: 200 })
    expect(calls.compare).toHaveBeenLastCalledWith({ slot: 7, metric: 'pod_state', limit: 1 })
  })

  it('shows a learned analyser\'s latest pod state for the chosen pod', () => {
    data.set('analyzers', [...(data.get('analyzers') as object[]), { ...base, id: 'pod-state', version: 1, label: 'Pod state (learned)', description: 'A small CNN.', primary: false, metrics: [{ name: 'pod_state', label: 'Pod state', description: '' }] }])
    data.set('compare:pod_state', [{ analyzer: 'pod-state', version: 1, source: 'device', points: [{ ts: '2026-01-02T00:00:00Z', value: 1, captureId: 'b' }] }])
    render(<AnalysisPage />)
    open('Methods')
    fireEvent.change(screen.getByLabelText('Pod'), { target: { value: '1' } })
    expect(screen.getByText('sprouted')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Analyser'), { target: { value: 'pod-state@1' } })
    expect(screen.queryByText('Make primary')).toBeNull()
  })

  it('shows everything known about a pod on hover, and pins it on a click for Methods to chart', () => {
    const state = { ...row('pod-state', 1, 1), metric: 'pod_state', detail: { state: 'sprouted', confidence: 0.9, probabilities: { empty: 0, sprouted: 0.9, unhealthy: 0.06 } } }
    data.set('analyzers', [...(data.get('analyzers') as object[]), { ...base, id: 'pod-state', version: 1, label: 'Pod state (learned)', description: 'A small CNN.', primary: false, metrics: [{ name: 'pod_state', label: 'Pod state', description: '' }] }])
    data.set('capture:upper-1', [row('exg-otsu', 1, 0.02), row('green-threshold', 1, 0.018), state])
    data.set('pods', [{ slot: 1, plant: 'Cilantro', status: 'seeded', plantedAt: '2026-01-01', notes: 'pinned to pod 1 by the caller' }, { slot: 3, plant: null, status: 'empty', plantedAt: null, notes: '' }])
    data.set('podTrends', [{ slot: 1, green: 0.018, verdict: 'growing', slope: 0.01, samples: 48, recent: [0, 0, 0.01, 0.018] }])
    render(<AnalysisPage />)
    expect(screen.queryByTestId('pod-card')).toBeNull()
    const hit = screen.getAllByRole('button', { name: 'Pod 1 details' })[0] as HTMLElement
    fireEvent.pointerEnter(hit)
    const card = screen.getByRole('dialog', { name: 'Pod 1' })
    expect(card.textContent).toContain('Cilantro')
    expect(card.textContent).toContain('Seeded · day')
    expect([...card.querySelectorAll('.font-mono.text-fg')].map(e => e.textContent)).toEqual(['2%', '2%', 'sprouted 90%'])
    expect(card.textContent).toContain('Growing over the last 4 photos')
    expect(card.textContent).toContain('pinned to pod 1 by the caller')
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    fireEvent.pointerLeave(hit)
    expect(screen.queryByTestId('pod-card')).toBeNull()

    fireEvent.click(hit)
    expect(hit.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Pod 1' })).toBeTruthy()
    // Hovering another pod shows it for a moment; leaving it brings the pinned one back.
    const other = screen.getAllByRole('button', { name: 'Pod 3 details' })[0] as HTMLElement
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
    expect(calls.compare).toHaveBeenLastCalledWith({ slot: 1, metric: 'pod_state', limit: 1 })
  })

  it('lets a pod\'s card reach past the photo\'s edge rather than cutting it off', () => {
    render(<AnalysisPage />)
    fireEvent.pointerEnter(screen.getAllByRole('button', { name: 'Pod 2 details' })[0] as HTMLElement)
    const clipped: string[] = []
    for (let el = screen.getByRole('dialog', { name: 'Pod 2' }).parentElement; el && el.tagName !== 'FIGURE'; el = el.parentElement) {
      if (el.classList.contains('overflow-hidden')) clipped.push(el.className)
    }
    expect(clipped).toEqual([])
  })

  it('says a pod marked empty has no cover, and hides the pod targets while the boxes are edited', () => {
    data.set('pods', [{ slot: 2, plant: null, status: 'empty', plantedAt: null, notes: '' }])
    render(<AnalysisPage />)
    fireEvent.pointerEnter(screen.getAllByRole('button', { name: 'Pod 2 details' })[0] as HTMLElement)
    expect(screen.getByRole('dialog', { name: 'Pod 2' }).textContent).toContain('Marked empty, so none of this counts as cover.')
    open('Teach')
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
    expect(screen.queryByLabelText('Analyser')).toBeNull()
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
