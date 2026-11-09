// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalysisPage, gapSummary } from '../AnalysisPage'

const { data, calls, invalidate, demo } = vi.hoisted(() => ({
  demo: { on: false },
  data: new Map<string, unknown>(),
  calls: { setPrimary: vi.fn(), rerun: vi.fn(), setRegions: vi.fn(), compare: vi.fn(), capture: vi.fn(), summary: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/demo/mode', () => ({ isDemo: () => demo.on }))
// The tagger has its own tests (labelPods.test.tsx); here it only has to be on the page with the pod boxes.
vi.mock('../LabelPods', () => ({ LabelPods: ({ boxes }: { boxes: (c: 'upper' | 'lower') => Record<number, unknown> }) => <div data-testid="label-pods-stub">{Object.keys(boxes('lower')).join(',')}</div> }))

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
      vision: { analyzers: query('analyzers'), status: query('status'), compare: query('compare'), capture: query('capture'), regions: query('regions'), setPrimary: mutation('setPrimary'), rerun: mutation('rerun'), setRegions: mutation('setRegions') },
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
const podRows = () => [...screen.getByRole('table').querySelectorAll('tbody tr')].filter(tr => tr.querySelector('td'))

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

const openExport = () => fireEvent.click(screen.getByText('Export dataset'))
afterEach(cleanup)

describe('AnalysisPage', () => {
  it('shows the primary analyser in one card and the others on request', () => {
    render(<AnalysisPage />)
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
    fireEvent.change(screen.getByLabelText('Analyser'), { target: { value: 'exg-otsu@1' } })
    fireEvent.click(screen.getByText('Make primary'))
    expect(calls.setPrimary).toHaveBeenCalledWith({ analyzer: 'exg-otsu' })
    fireEvent.click(screen.getByText('Re-run'))
    expect(calls.rerun).toHaveBeenCalledWith({ analyzer: 'exg-otsu', limit: 2000 })
    expect(invalidate).toHaveBeenCalled()
  })

  it('compares the chosen pod across analysers', () => {
    render(<AnalysisPage />)
    expect(screen.getByRole('img', { name: 'green-threshold@1, exg-otsu@1' })).toBeTruthy()
    expect(screen.getByText('52%')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Pod'), { target: { value: '7' } })
    expect(calls.compare).toHaveBeenCalledWith({ slot: 7, metric: 'green_fraction', limit: 200 })
    expect(calls.compare).toHaveBeenLastCalledWith({ slot: 7, metric: 'pod_state', limit: 1 })
  })

  it('shows a learned analyser\'s pod states beside the green fractions', () => {
    const state = (slot: number, value: number, detail: Record<string, unknown> | null) => ({ ...row('pod-state', slot, value), metric: 'pod_state', detail })
    data.set('analyzers', [...(data.get('analyzers') as object[]), { ...base, id: 'pod-state', version: 1, label: 'Pod state (learned)', description: 'A small CNN.', primary: false, metrics: [{ name: 'pod_state', label: 'Pod state', description: '' }] }])
    data.set('capture:upper-1', [row('green-threshold', 1, 0.4), state(1, 2, { state: 'growing', confidence: 0.87 }), state(2, 0, null)])
    data.set('compare:pod_state', [{ analyzer: 'pod-state', version: 1, source: 'device', points: [{ ts: '2026-01-02T00:00:00Z', value: 1, captureId: 'b' }] }])
    render(<AnalysisPage />)
    const table = screen.getByRole('table')
    expect([...table.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['POD', 'PLANT', 'LEAF COVER', 'THRESHOLD', 'OTSU', 'STATE'])
    expect(podRows()[0]?.textContent).toContain('growing')
    expect(podRows()[0]?.querySelector('td[title="growing · 87%"]')).toBeTruthy()
    expect(podRows()[1]?.textContent).toContain('empty')
    expect(screen.getByText('sprouted')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Analyser'), { target: { value: 'pod-state@1' } })
    expect(screen.queryByText('Make primary')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Pod bounds' }))
    expect(screen.getAllByTestId('pod-bounds')[0]?.querySelector('[data-slot]')?.textContent).toBe('1 · growing')
  })

  it('says when an on-device analyser is off, and offers no re-run', () => {
    data.set('analyzers', [{ ...base, id: 'pod-state', version: 1, label: 'Pod state (learned)', description: 'A small CNN.', primary: false, metrics: [], captures: 0, rows: 0, disabled: 'No weights file is installed, so this analyser is off.' }])
    render(<AnalysisPage />)
    expect(screen.getByText('Off. No weights file is installed, so this analyser is off.')).toBeTruthy()
    expect(screen.queryByText('Re-run')).toBeNull()
  })

  it('shows both cameras\' stills and every analyser\'s green fraction per pod in one table, in listing order', () => {
    render(<AnalysisPage />)
    expect(screen.getByAltText('upper camera at 2026-01-02T00:00:00Z')).toBeTruthy()
    expect(screen.getByAltText('lower camera at 2026-01-02T00:00:00Z')).toBeTruthy()
    const table = screen.getByRole('table')
    expect([...table.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['POD', 'PLANT', 'LEAF COVER', 'THRESHOLD', 'OTSU'])
    expect([...table.querySelectorAll('th[scope=rowgroup]')].map(th => th.textContent?.split(' · ')[0])).toEqual(['UPPER', 'LOWER'])
    expect(podRows().map(tr => tr.querySelector('td')?.textContent)).toEqual(['1', '2', '16'])
    expect(table.textContent).toContain('Swiss Chard')
    expect(table.textContent).toContain('—')
    expect(table.textContent).not.toContain('300%')
    expect(podRows()[2]?.textContent).toContain('25%')
    expect(screen.getByText('Excess green + Otsu reads 5 points higher than Fixed green threshold on every pod.')).toBeTruthy()
  })

  it('narrows the stills and the table to one camera', () => {
    data.set('capture:upper-1', Array.from({ length: 15 }, (_, i) => row('green-threshold', i + 1, 0.3)))
    data.set('capture:lower-1', Array.from({ length: 15 }, (_, i) => row('green-threshold', i + 16, 0.3)))
    render(<AnalysisPage />)
    expect(podRows()).toHaveLength(30)
    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))
    expect(podRows()).toHaveLength(15)
    expect(podRows()[0]?.querySelector('td')?.textContent).toBe('16')
    expect(screen.queryByAltText('upper camera at 2026-01-02T00:00:00Z')).toBeNull()
    expect(screen.getByAltText('lower camera at 2026-01-02T00:00:00Z')).toBeTruthy()
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

  it('reports a pod marked empty as no cover rather than a number', () => {
    data.set('pods', [{ slot: 1, plant: null, status: 'empty' }, { slot: 2, plant: 'Basil', status: 'growing' }])
    render(<AnalysisPage />)
    const [first, second] = podRows()
    expect(first?.textContent).toContain('Empty · no cover')
    expect(first?.textContent).not.toContain('%')
    expect(first?.getAttribute('title')).toBe('Marked empty; analysers read 40%, 45%')
    expect(second?.textContent).toContain('10%')
  })

  it('draws the bounds each pod is scored on over both stills, with the chosen analyser\'s reading', () => {
    data.set('pods', [{ slot: 2, plant: null, status: 'empty' }])
    render(<AnalysisPage />)
    expect(screen.queryByTestId('pod-bounds')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Pod bounds' }))
    const [upper, lower] = screen.getAllByTestId('pod-bounds')
    expect(upper?.querySelectorAll('[data-slot]')).toHaveLength(15)
    const labels = [...(upper?.querySelectorAll('[data-slot]') ?? [])].map(s => s.textContent)
    expect(labels.slice(0, 3)).toEqual(['1 · 40%', '2', '3'])
    expect(lower?.querySelector('[data-slot]')?.textContent).toBe('16 · 20%')
    expect(screen.getByText(/dashed middle/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Analyser'), { target: { value: 'exg-otsu@1' } })
    expect(screen.getAllByTestId('pod-bounds')[0]?.querySelector('[data-slot]')?.textContent).toBe('1 · 45%')
  })

  it('draws the unit\'s calibrated boxes, and says which cameras have them', () => {
    data.set('regions', [{ camera: 'upper', calibrated: true, regions: [{ slot: 1, x: 0.5, y: 0.25, w: 0.2, h: 0.1, moved: true }] }])
    render(<AnalysisPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Pod bounds' }))
    const box = screen.getAllByTestId('pod-bounds')[0]?.querySelector('[data-slot="1"]') as HTMLElement
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['50%', '25%', '20%', '10%'])
    expect(screen.getByText('· calibrated boxes')).toBeTruthy()
    expect(screen.getByText('· measured boxes')).toBeTruthy()
  })

  it('edits the boxes by keyboard and saves each camera\'s', async () => {
    render(<AnalysisPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Pod bounds' }))
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
    fireEvent.click(screen.getByRole('tab', { name: 'Pod bounds' }))
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

  it('shows why the boxes could not be saved', async () => {
    data.set('setRegionsError', new Error('pod 16 is not on the upper camera'))
    render(<AnalysisPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Pod bounds' }))
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
    expect(screen.getByText(/haven't been scored yet/)).toBeTruthy()
    expect(screen.getByText('already re-running exg-otsu')).toBeTruthy()
    cleanup()
    data.set('frames:upper', [])
    data.set('frames:lower', [])
    data.set('analyzers', [])
    data.set('status', { running: 'upper-9', waiting: [], dropped: 0, failed: 0, backfill: null })
    render(<AnalysisPage />)
    expect(screen.getByText('Scoring upper-9')).toBeTruthy()
    expect(screen.getByText('No photos yet.')).toBeTruthy()
    expect(screen.getAllByText('No photos from this camera yet.')).toHaveLength(2)
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

describe('gapSummary', () => {
  const labels = { 'a@1': 'A', 'b@1': 'B' }
  const r = (analyzer: string, slot: number, value: number) => row(analyzer, slot, value) as Parameters<typeof gapSummary>[0][number]
  it('says which way and by how much the second analyser reads', () => {
    expect(gapSummary([r('a', 1, 0.5), r('b', 1, 0.53), r('a', 2, 0.4), r('b', 2, 0.46)], ['a@1', 'b@1'], labels)).toBe('B reads 3–6 points higher than A on every pod.')
    expect(gapSummary([r('a', 1, 0.5), r('b', 1, 0.4)], ['a@1', 'b@1'], labels)).toBe('B reads 10 points lower than A on every pod.')
    expect(gapSummary([r('a', 1, 0.5), r('b', 1, 0.4), r('a', 2, 0.1), r('b', 2, 0.3)], ['a@1', 'b@1'], labels)).toBe('B and A differ by up to 20 points.')
  })
  it('stays quiet with one analyser or no shared pods', () => {
    expect(gapSummary([r('a', 1, 0.5)], ['a@1'], labels)).toBeNull()
    expect(gapSummary([r('a', 1, 0.5), r('b', 2, 0.4)], ['a@1', 'b@1'], {})).toBeNull()
  })
})
