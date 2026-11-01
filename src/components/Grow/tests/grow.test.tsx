// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrowPage } from '../GrowPage'

const { data, calls, tower } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { start: vi.fn(), end: vi.fn(), setStage: vi.fn(), updatePod: vi.fn() },
  tower: { props: null as null | Record<string, unknown>, unavailable: false },
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: () => ({ isPending: false, mutate: (i?: unknown) => calls[name](i) }) })
  return {
    trpc: {
      useUtils: () => ({ grow: { invalidate: vi.fn(), pods: { invalidate: vi.fn() } } }),
      grow: { current: query('grow'), pods: query('pods'), start: mutation('start'), end: mutation('end'), setStage: mutation('setStage'), updatePod: mutation('updatePod') },
      vision: { podTrends: query('trends') },
      sensors: { latest: query('sensors') },
      light: { get: query('light') },
    },
  }
})

// The 3D view is covered by tower.test.ts and the browser tests; here it reports what it was given.
vi.mock('../TowerView', () => ({
  TowerView: (props: Record<string, unknown>) => {
    tower.props = props
    if (tower.unavailable) queueMicrotask(() => (props.onUnavailable as () => void)())
    return <div data-testid="tower" />
  },
}))

const pod = (slot: number, o: Record<string, unknown> = {}) => ({ slot, plant: null, plantedAt: null, status: 'empty', notes: '', updatedAt: '', ...o })

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  tower.props = null
  tower.unavailable = false
  localStorage.clear()
  data.set('grow', { cycle: { id: 'c1', startedAt: '2026-10-12T00:00:00Z', endedAt: null, stage: 'vegetative', notes: 'greens', issued: [] }, day: 19 })
  data.set('pods', [pod(1, { plant: 'Basil', status: 'growing', plantedAt: '2026-10-12' }), pod(2, { plant: 'Kale', status: 'attention', notes: 'yellow' }), pod(3)])
  data.set('trends', [{ slot: 1, green: 0.42, verdict: 'growing', slope: 0.01, samples: 6, recent: [0.2, 0.3, 0.42] }])
  data.set('sensors', { water_level_pct: { value: 64, unit: '%', ts: '' } })
  data.set('light', { on: true, level: 85 })
})
afterEach(cleanup)

describe('Grow', () => {
  it('opens on the table: each pod with its plant, age and growth', () => {
    render(<GrowPage />)
    expect(screen.queryByTestId('tower')).toBeNull()
    const basil = screen.getByRole('button', { name: '1 Basil' })
    expect(basil.textContent).toMatch(/^1d\d+Basil42%$/)
    expect(basil.querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('button', { name: '3 empty' }).textContent).toBe('3Empty')
    fireEvent.click(basil)
    expect(screen.getByText('Pod 1')).toBeTruthy()
  })

  it('feeds the tower the pods, their green area, the tank and the light', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tower' }))
    expect(screen.getByTestId('tower')).toBeTruthy()
    expect(tower.props).toMatchObject({ waterPct: 64, lightLevel: 85, selected: null })
    expect((tower.props?.pods as unknown[])[0]).toEqual({ slot: 1, status: 'growing', plant: 'Basil', green: 0.42, ageDays: expect.any(Number) })
    expect(screen.getByTestId('pod-counts').textContent).toBe('1 growing · 0 ready · 1 attention · 1 empty')
  })

  it('edits the pod picked on the tower in the side panel', () => {
    render(<GrowPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tower' }))
    act(() => (tower.props?.onSelect as (s: number) => void)(1))
    expect(screen.getByText('Pod 1')).toBeTruthy()
    expect(screen.getByText('42% · growing')).toBeTruthy()
    expect(screen.getByText('2026-10-12')).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'Thai Basil' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'harvest' } })
    fireEvent.click(save)
    expect(calls.updatePod).toHaveBeenCalledWith({ slot: 1, plant: 'Thai Basil', status: 'harvest', notes: '', plantedAt: undefined })
  })

  it('picks a pod from the list too, and reverts unsaved edits', () => {
    render(<GrowPage />)
    fireEvent.change(screen.getByLabelText('Pod', { exact: true }), { target: { value: '2' } })
    expect((screen.getByLabelText('Notes') as HTMLInputElement).value).toBe('yellow')
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'better' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    expect((screen.getByLabelText('Notes') as HTMLInputElement).value).toBe('yellow')
  })

  it('stamps the planted date when a pod is newly seeded', () => {
    render(<GrowPage />)
    fireEvent.change(screen.getByLabelText('Pod', { exact: true }), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'seeded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.updatePod).toHaveBeenCalledWith(expect.objectContaining({ slot: 3, status: 'seeded', plantedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }))
  })

  it('switches to the tower and remembers it', () => {
    const { unmount } = render(<GrowPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tower' }))
    expect(screen.getByTestId('tower')).toBeTruthy()
    unmount()
    render(<GrowPage />)
    expect(screen.getByTestId('tower')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }))
    expect(screen.queryByTestId('tower')).toBeNull()
  })

  it('falls back to the table without WebGL', async () => {
    tower.unavailable = true
    localStorage.setItem('seedypod.growView', 'tower')
    render(<GrowPage />)
    expect(await screen.findByText(/needs WebGL/)).toBeTruthy()
    expect(screen.queryByTestId('tower')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Tower' })).toBeNull()
  })

  it('changes the stage and ends the cycle from the side panel', () => {
    render(<GrowPage />)
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'harvest' } })
    expect(calls.setStage).toHaveBeenCalledWith({ stage: 'harvest' })
    fireEvent.click(screen.getByRole('button', { name: 'End cycle' }))
    expect(calls.end).toHaveBeenCalled()
  })
})
