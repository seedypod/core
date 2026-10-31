// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalysisPage } from '../AnalysisPage'

const { data, calls, invalidate, demo } = vi.hoisted(() => ({
  demo: { on: false },
  data: new Map<string, unknown>(),
  calls: { setPrimary: vi.fn(), rerun: vi.fn(), compare: vi.fn(), capture: vi.fn(), summary: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/demo/link', () => ({ isDemo: () => demo.on }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: (input?: unknown, opts?: { enabled?: boolean }) => {
    if (name === 'compare') calls.compare(input)
    if (name === 'capture') calls.capture(input, opts)
    if (name === 'summary') calls.summary(input)
    return { data: opts?.enabled === false ? undefined : data.get(name) }
  } })
  const mutation = (name: 'setPrimary' | 'rerun') => ({ useMutation: (o?: { onSuccess?: () => void }) => ({
    isPending: false,
    error: data.get(`${name}Error`) ?? null,
    mutate: (input: unknown) => {
      calls[name](input)
      o?.onSuccess?.()
    },
  }) })
  return {
    apiBase: () => '',
    trpc: {
      useUtils: () => ({ vision: { invalidate } }),
      vision: { analyzers: query('analyzers'), status: query('status'), compare: query('compare'), capture: query('capture'), setPrimary: mutation('setPrimary'), rerun: mutation('rerun') },
      camera: { list: query('frames') },
      datasets: { summary: query('summary') },
    },
  }
})

const metric = { name: 'green_fraction', label: 'Green area', description: '' }
const base = { metrics: [metric], runsOn: ['device'], source: 'device', rows: 30, captures: 2, firstTs: '2026-01-01T00:00:00Z', lastTs: '2026-01-02T00:00:00Z' }
const row = (analyzer: string, slot: number, value: number) => ({ captureId: 'upper-1', ts: '2026-01-02T00:00:00Z', camera: 'upper', analyzer, version: 1, source: 'device', slot, metric: 'green_fraction', value, detail: null, artifact: null })

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
  data.set('compare', [
    { analyzer: 'green-threshold', version: 1, source: 'device', points: [{ ts: '2026-01-01T00:00:00Z', value: 0.2, captureId: 'a' }, { ts: '2026-01-02T00:00:00Z', value: 0.4, captureId: 'b' }] },
    { analyzer: 'exg-otsu', version: 1, source: 'device', points: [{ ts: '2026-01-02T00:00:00Z', value: 0.52, captureId: 'b' }] },
  ])
  data.set('frames', [{ id: 'upper-1', camera: 'upper', ts: '2026-01-02T00:00:00Z', path: 'x.jpg', bytes: 1, url: '/api/captures/upper-1.jpg' }])
  data.set('capture', [row('green-threshold', 1, 0.4), row('exg-otsu', 1, 0.45), row('green-threshold', 2, 0.1), { ...row('exg-otsu', 2, 3), metric: 'leaf_count' }])
})
afterEach(cleanup)

describe('AnalysisPage', () => {
  it('lists analysers with their source, primary flag and totals', () => {
    render(<AnalysisPage />)
    expect(screen.getByText('Fixed green threshold')).toBeTruthy()
    expect(screen.getAllByText('Primary')).toHaveLength(1)
    expect(screen.getAllByText('On device')).toHaveLength(2)
    expect(screen.getByText('Remote')).toBeTruthy()
    expect(screen.getByText('No results yet')).toBeTruthy()
    // Re-run is offered only for analysers that run here.
    expect(screen.getAllByText('Re-run on stored photos')).toHaveLength(2)
  })

  it('makes an analyser primary and starts a re-run', () => {
    render(<AnalysisPage />)
    fireEvent.click(screen.getAllByText('Make primary')[0] as HTMLElement)
    expect(calls.setPrimary).toHaveBeenCalledWith({ analyzer: 'exg-otsu' })
    fireEvent.click(screen.getAllByText('Re-run on stored photos')[1] as HTMLElement)
    expect(calls.rerun).toHaveBeenCalledWith({ analyzer: 'exg-otsu', limit: 2000 })
    expect(invalidate).toHaveBeenCalled()
  })

  it('compares the chosen pod across analysers', () => {
    render(<AnalysisPage />)
    expect(screen.getByRole('img', { name: 'green-threshold@1, exg-otsu@1' })).toBeTruthy()
    expect(screen.getByText('52%')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Pod'), { target: { value: '7' } })
    expect(calls.compare).toHaveBeenLastCalledWith({ slot: 7, metric: 'green_fraction', limit: 200 })
  })

  it('shows the latest photo with every analyser\'s green fraction per pod', () => {
    render(<AnalysisPage />)
    const table = screen.getByRole('table')
    expect(table.textContent).toContain('green-threshold@1')
    expect(table.textContent).toContain('exg-otsu@1')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(table.textContent).toContain('—')
    expect(table.textContent).not.toContain('300%')
  })

  it('reports progress, failures and empty states', () => {
    data.set('status', { running: null, waiting: [], dropped: 0, failed: 2, backfill: { analyzer: 'exg-otsu', done: 3, total: 10 } })
    data.set('capture', [])
    data.set('rerunError', new Error('already re-running exg-otsu'))
    render(<AnalysisPage />)
    expect(screen.getByText(/Re-running exg-otsu: 3 of 10 captures · 2 captures could not be scored/)).toBeTruthy()
    expect(screen.getByText(/hasn't been scored yet/)).toBeTruthy()
    expect(screen.getAllByText('already re-running exg-otsu').length).toBeGreaterThan(0)
    cleanup()
    data.set('frames', [])
    data.set('status', { running: 'upper-9', waiting: [], dropped: 0, failed: 0, backfill: null })
    render(<AnalysisPage />)
    expect(screen.getByText('Scoring upper-9')).toBeTruthy()
    expect(screen.getByText('No photos from this camera yet.')).toBeTruthy()
    expect(calls.capture).toHaveBeenLastCalledWith({ captureId: '' }, { enabled: false })
  })

  it('offers a dataset download for the chosen window, with or without photos', () => {
    data.set('summary', { from: '', to: '', images: true, captures: 12, analyses: 360, telemetry: 900, imageBytes: 2_400_000 })
    render(<AnalysisPage />)
    expect(screen.getByText('12 photos · 360 results · 900 readings · about 2.4 MB')).toBeTruthy()
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
    expect(screen.getByText(/Downloads need a real unit/)).toBeTruthy()
    expect(screen.queryByText('Download')).toBeNull()
  })
})
