// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrowPage } from '../GrowPage'

const { data, calls, tower } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { start: vi.fn(), end: vi.fn(), setStage: vi.fn(), updatePod: vi.fn(), markHarvested: vi.fn(), swapPods: vi.fn() },
  tower: { props: null as null | Record<string, unknown>, unavailable: false },
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: () => ({ isPending: false, mutate: (i?: unknown, o?: { onSuccess?: () => void }) => {
    calls[name](i)
    o?.onSuccess?.()
  } }) })
  return {
    apiBase: () => '',
    trpc: {
      useUtils: () => ({ grow: { invalidate: vi.fn() } }),
      grow: { current: query('grow'), pods: query('pods'), harvest: query('harvest'), start: mutation('start'), end: mutation('end'), setStage: mutation('setStage'), updatePod: mutation('updatePod'), markHarvested: mutation('markHarvested'), swapPods: mutation('swapPods') },
      settings: { get: query('settings') },
      camera: { list: query('captures') },
      vision: { podTrends: query('trends'), regions: query('regions') },
      sensors: { latest: query('sensors') },
      light: { get: query('light') },
    },
  }
})

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children, className }: { to: string, children: ReactNode, className?: string }) => <a href={to} className={className}>{children}</a> }))

// The 3D view is covered by tower.test.ts and the browser tests; here it reports what it was given.
vi.mock('../TowerView', () => ({
  TowerView: (props: Record<string, unknown>) => {
    tower.props = props
    if (tower.unavailable) queueMicrotask(() => (props.onUnavailable as () => void)())
    return <div data-testid="tower" />
  },
}))

const pod = (slot: number, o: Record<string, unknown> = {}) => ({ slot, plant: null, plantedAt: null, status: 'empty', notes: '', updatedAt: '', statusSince: null, lastHarvestAt: null, ...o })

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  tower.props = null
  tower.unavailable = false
  localStorage.clear()
  window.history.replaceState(null, '', '/grow')
  data.set('grow', { cycle: { id: 'c1', startedAt: '2026-10-12T00:00:00Z', endedAt: null, stage: 'vegetative', notes: 'greens', issued: [] }, day: 19 })
  data.set('pods', [pod(1, { plant: 'Basil', status: 'growing', plantedAt: '2026-10-12' }), pod(2, { plant: 'Kale', status: 'attention', notes: 'yellow' }), pod(3)])
  data.set('trends', [{ slot: 1, green: 0.42, verdict: 'growing', slope: 0.01, samples: 6, recent: [0.2, 0.3, 0.42] }])
  data.set('sensors', { water_level_pct: { value: 64, unit: '%', ts: '' } })
  data.set('light', { on: true, level: 85 })
  data.set('settings', { harvestReminderDays: 35 })
  data.set('harvest', [{ slot: 1, plant: 'Basil', state: 'growing', ageDays: 19, cover: 0.42, targetCover: 0.5, coverPerDay: 0.012, window: { start: 24, end: 39, source: 'profile' }, daysToReady: 5, daysLeft: null, profile: 'Basil', reason: '5 d until its 24–39 d window.' }])
  data.set('captures', [{ id: 'u1', camera: 'upper', ts: new Date(Date.now() - 6 * 3_600_000).toISOString(), path: '/data/u1.jpg', bytes: 1, url: '/api/captures/u1.jpg' }])
})
afterEach(cleanup)

describe('Grow', () => {
  it('opens on the pods: one row per pod with its plant and leaf cover, split by tower', () => {
    render(<GrowPage />)
    expect(screen.queryByTestId('tower')).toBeNull()
    expect(screen.getByText('TOWER A · PODS 1–2')).toBeTruthy()
    expect(screen.getByText('TOWER B · PODS 3–3')).toBeTruthy()
    const basil = screen.getByRole('button', { name: '1 Basil' })
    expect(basil.textContent).toBe('1Basil42%')
    expect(screen.getByRole('button', { name: '3 empty' }).textContent).toBe('3Empty · plant')
    expect(screen.getByText('Click a pod in the list to see and edit it. Drag one onto another to swap them after moving their yCubes.')).toBeTruthy()
    fireEvent.click(basil)
    expect(basil.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('complementary', { name: 'Pod 1' })).toBeTruthy()
    expect(screen.getByText('POD 1 · TOWER A')).toBeTruthy()
  })

  it('takes the tower split from the pod count: three towers of ten on a Home, two of eight on a Studio', () => {
    data.set('pods', Array.from({ length: 30 }, (_, i) => pod(i + 1)))
    const { unmount } = render(<GrowPage />)
    expect(screen.getByText('TOWER A · PODS 1–10')).toBeTruthy()
    expect(screen.getByText('TOWER C · PODS 21–30')).toBeTruthy()
    unmount()
    data.set('pods', Array.from({ length: 16 }, (_, i) => pod(i + 1)))
    render(<GrowPage />)
    expect(screen.getByText('TOWER B · PODS 9–16')).toBeTruthy()
    expect(screen.queryByText(/TOWER C/)).toBeNull()
  })

  it('shows the cycle: name, start, day of its length, stage and counts', () => {
    render(<GrowPage />)
    expect(screen.getByText(/^greens · started /)).toBeTruthy()
    expect(screen.getByText('Day 19')).toBeTruthy()
    expect(screen.getByText('of ~35')).toBeTruthy()
    expect((screen.getByLabelText('Stage') as HTMLSelectElement).value).toBe('vegetative')
    expect(screen.getByTestId('pod-counts').textContent).toBe('1 growing0 ready1 attention1 empty')
  })

  it('leaves out the cycle length when the harvest reminder is off', () => {
    data.set('settings', { harvestReminderDays: 0 })
    render(<GrowPage />)
    expect(screen.queryByText(/^of ~/)).toBeNull()
  })

  it('opens the pod named in ?pod=N, and closes it', () => {
    window.history.replaceState(null, '', '/grow?pod=2')
    render(<GrowPage />)
    expect(screen.getByText('POD 2 · TOWER A')).toBeTruthy()
    expect(screen.getByText('Needs attention')).toBeTruthy()
    expect(screen.getByText('yellow')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('POD 2 · TOWER A')).toBeNull()
  })

  it('details the picked pod: its crop, leaf-cover trend, seeded date and harvest window', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    const panel = screen.getByRole('complementary', { name: 'Pod 1' })
    expect(panel.textContent).toContain('5 d until its 24–39 d window.')
    const img = screen.getByRole('img', { name: 'Pod 1 on the upper camera' }) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/captures/u1.jpg')
    // Pod 1's measured box on the upper camera.
    expect(img.style.transform).toBe('translate(-6.84%, -13.81%)')
    expect(screen.getByText('upper camera · 6 h ago')).toBeTruthy()
    expect(panel.querySelector('svg path')).not.toBeNull()
    expect(screen.getByText('Growing, +1.2% a day.')).toBeTruthy()
    expect(screen.getByText('day 24–39')).toBeTruthy()
    expect(screen.getByText('Oct 12')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Photos' }).getAttribute('href')).toBe('/cameras')
  })

  it('pictures each pod\'s plant in its row, and the picked one as a model to scrub from seedling to harvest', () => {
    render(<GrowPage />)
    const kinds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="plant-thumb"]')].map(t => t.dataset.kind)
    // No WebGL in jsdom: a neutral leaf for each planted pod, a ring for the empty one.
    expect(kinds(screen.getByLabelText('Pods'))).toEqual(['neutral', 'neutral', 'empty'])
    expect(screen.getByRole('button', { name: '1 Basil' }).querySelector<HTMLElement>('[data-testid="plant-thumb"]')?.style.width).toBe('32px')
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    const stage = screen.getByRole('slider', { name: 'Growth stage' })
    expect(stage.getAttribute('aria-valuetext')).toBe('bushy (today)')
    fireEvent.change(stage, { target: { value: '3' } })
    expect(stage.getAttribute('aria-valuetext')).toBe('harvest')
    expect(screen.queryByText('generic model')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '3 empty' }))
    expect(screen.queryByTestId('plant-model')).toBeNull()
  })

  it('gives the picked pod\'s light zone, and where its plant would grow better, as the plant is picked', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    expect(screen.getByText('Light zone').nextElementSibling?.textContent).toBe('Medium light')
    expect(screen.queryByTestId('placement-advice')).toBeNull()
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'Cherry Tomato' } })
    expect(screen.getByTestId('placement-advice').textContent).toBe('Red Cherry Tomato grows best in high light; this pod gets medium.')
    fireEvent.click(screen.getByRole('button', { name: '2 Kale' }))
    expect(screen.getByTestId('placement-advice').textContent).toBe('Kale grows best in medium light; this pod gets low. Free pods that suit it: 3.')
    fireEvent.click(screen.getByRole('button', { name: /^3 / }))
    expect(screen.getByTestId('placement-advice').textContent).toBe('Suits this pod: Basil, Breen Lettuce, Buttercrunch, Butterhead, Celery, Dianthus.')
  })

  it('crops a lower pod from the lower camera, and says when there is no photo or trend yet', () => {
    data.set('pods', Array.from({ length: 30 }, (_, i) => pod(i + 1, { plant: 'Mint', status: 'growing' })))
    data.set('captures', [])
    data.set('trends', [])
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '20 Mint' }))
    expect(screen.getByText('no photo yet · lower camera')).toBeTruthy()
    expect(screen.getByText('Not enough photos yet for a trend.')).toBeTruthy()
    // No planting date, no window.
    expect(screen.getAllByText('—')).toHaveLength(3)
  })

  it('gives the camera rate as the trend before there are enough photos for a verdict', () => {
    data.set('trends', [{ slot: 1, green: 0.42, verdict: 'unknown', slope: 0, samples: 3, recent: [0.2, 0.3, 0.42] }])
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    expect(screen.getByText('+1.2% a day over the recent photos.')).toBeTruthy()
  })

  it('fits the crop box to the drawn still once it loads', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    const img = screen.getByRole('img', { name: 'Pod 1 on the upper camera' })
    Object.defineProperty(img, 'offsetWidth', { value: 1200 })
    Object.defineProperty(img, 'offsetHeight', { value: 900 })
    fireEvent.load(img)
    // A 4:3 still: the measured boxes are square on it.
    expect(Number(img.parentElement?.dataset.aspect)).toBeCloseTo(1)
  })

  it('crops to the box the owner calibrated for the pod', () => {
    data.set('regions', [{ camera: 'upper', calibrated: true, regions: [{ slot: 1, x: 0.5, y: 0.25, w: 0.2, h: 0.1, moved: true }] }])
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    const img = screen.getByRole('img', { name: 'Pod 1 on the upper camera' }) as HTMLImageElement
    expect(img.style.transform).toBe('translate(-50%, -25%)')
    expect(img.style.width).toBe('500%')
  })

  it('feeds the tower the pods, their green area and outlook, the tank and the light', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tower' }))
    expect(screen.getByTestId('tower')).toBeTruthy()
    expect(tower.props).toMatchObject({ waterPct: 64, lightLevel: 85, selected: null })
    expect((tower.props?.pods as unknown[])[0]).toMatchObject({ slot: 1, status: 'growing', plant: 'Basil', green: 0.42, ageDays: expect.any(Number), harvest: expect.objectContaining({ state: 'growing' }) })
    expect(screen.getByText('Click a pod on the tower to see and edit it.')).toBeTruthy()
  })

  it('edits the pod picked on the tower in the side panel', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tower' }))
    act(() => (tower.props?.onSelect as (s: number) => void)(1))
    expect(screen.getByText('POD 1 · TOWER A')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'Thai Basil' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'harvest' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.updatePod).toHaveBeenCalledWith({ slot: 1, plant: 'Thai Basil', status: 'harvest', notes: '', plantedAt: undefined })
  })

  it('offers the catalog plants to pick from', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    const list = document.getElementById(screen.getByLabelText('Plant').getAttribute('list') ?? '')
    expect(list?.querySelector('option[value="Kale"]')).not.toBeNull()
  })

  it('reverts unsaved edits', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '2 Kale' }))
    expect((screen.getByLabelText('Notes') as HTMLInputElement).value).toBe('yellow')
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'better' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    expect((screen.getByLabelText('Notes') as HTMLInputElement).value).toBe('yellow')
  })

  it('stamps the planted date when a pod is newly seeded', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '3 empty' }))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'seeded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.updatePod).toHaveBeenCalledWith(expect.objectContaining({ slot: 3, status: 'seeded', plantedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }))
  })

  it('dismisses a pod needing attention back to growing', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '2 Kale' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(calls.updatePod).toHaveBeenCalledWith({ slot: 2, status: 'growing' })
  })

  it('marks a ready pod harvested', () => {
    data.set('pods', [pod(1, { plant: 'Basil', status: 'harvest', plantedAt: '2026-10-12' })])
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('button', { name: '1 Basil' }))
    expect(screen.getByText('Ready to harvest')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mark harvested' }))
    expect(calls.markHarvested).toHaveBeenCalledWith({ slot: 1 })
  })

  it('switches to the tower and remembers it', () => {
    const { unmount } = render(<GrowPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tower' }))
    expect(screen.getByTestId('tower')).toBeTruthy()
    unmount()
    render(<GrowPage />)
    expect(screen.getByTestId('tower')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Pods' }))
    expect(screen.queryByTestId('tower')).toBeNull()
  })

  it('falls back to the pods without WebGL', async () => {
    tower.unavailable = true
    localStorage.setItem('seedypod.growView', 'tower')
    render(<GrowPage />)
    expect(await screen.findByText(/needs WebGL/)).toBeTruthy()
    expect(screen.queryByTestId('tower')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Tower' })).toBeNull()
  })

  it('changes the stage from the stage bar and ends the cycle', () => {
    render(<GrowPage />)
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'harvest' } })
    expect(calls.setStage).toHaveBeenCalledWith({ stage: 'harvest' })
    fireEvent.click(screen.getByRole('button', { name: 'End cycle' }))
    expect(calls.end).toHaveBeenCalled()
  })

  it('starts a named cycle when none is running', () => {
    data.set('grow', { cycle: null, day: null })
    render(<GrowPage />)
    expect(screen.getAllByText('No active cycle')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'End cycle' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Cycle name'), { target: { value: ' Spring herbs ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start cycle' }))
    expect(calls.start).toHaveBeenCalledWith({ notes: 'Spring herbs' })
  })
})

describe('GrowPage: swapping pods', () => {
  const row = (slot: number) => screen.getByRole('button', { name: new RegExp(`^${slot} `) })

  it('swaps two pods by dragging one row onto another', () => {
    render(<GrowPage />)
    const data = new Map<string, string>()
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' }
    fireEvent.dragStart(row(1), { dataTransfer })
    fireEvent.dragOver(row(3), { dataTransfer })
    fireEvent.drop(row(3), { dataTransfer })
    expect(calls.swapPods).toHaveBeenCalledWith({ a: 1, b: 3 })
    // Dropped on itself: nothing.
    fireEvent.dragStart(row(2), { dataTransfer })
    fireEvent.drop(row(2), { dataTransfer })
    expect(calls.swapPods).toHaveBeenCalledTimes(1)
  })

  it('swaps from the pod panel by picking the other pod, on the tower too, and can cancel', () => {
    render(<GrowPage />)
    fireEvent.click(row(1))
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
    expect(screen.getByTestId('swap-banner').textContent).toContain('Pick the pod to swap pod 1 (Basil) with.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('swap-banner')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
    fireEvent.click(row(2))
    expect(calls.swapPods).toHaveBeenCalledWith({ a: 1, b: 2 })
    expect(screen.queryByTestId('swap-banner')).toBeNull()
  })

  it('names an empty pod by number alone while picking', () => {
    render(<GrowPage />)
    fireEvent.click(row(3))
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
    expect(screen.getByTestId('swap-banner').textContent).toContain('Pick the pod to swap pod 3 with.')
  })
})
