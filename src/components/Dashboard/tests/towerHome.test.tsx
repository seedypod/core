// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TowerHome } from '../TowerHome'

const { data, calls, tower, navigate } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { markHarvested: vi.fn(), updatePod: vi.fn() },
  tower: { props: null as null | Record<string, unknown> },
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, ...rest }: { children: ReactNode, to: string, search?: { pod: number } }) => <a href={search ? `${to}?pod=${search.pod}` : to} {...rest}>{children}</a>,
  useNavigate: () => navigate,
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name), refetch: vi.fn() }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: () => ({ isPending: false, error: null, mutate: (i?: unknown) => calls[name](i) }) })
  return {
    trpc: {
      sensors: { latest: query('sensors') },
      light: { get: query('light') },
      pump: { get: query('pump') },
      grow: { current: query('grow'), pods: query('pods'), harvest: query('harvest'), markHarvested: mutation('markHarvested'), updatePod: mutation('updatePod') },
      vision: { podTrends: query('trends') },
    },
  }
})

// The real view needs WebGL; this one renders the overlay and pod action it's given and exposes its callbacks.
vi.mock('@/src/components/Grow/TowerView', () => ({
  TowerView: (props: { controls: ReactNode, podAction: ReactNode }) => {
    tower.props = props
    return (
      <div data-testid="tower">
        {props.controls}
        <div data-testid="pod-action">{props.podAction}</div>
      </div>
    )
  },
}))

const r = (value: number, unit: string) => ({ value, unit, ts: '2026-10-31T00:00:00Z' })
beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  navigate.mockReset()
  data.set('sensors', { air_temp: r(22.5, '°C'), humidity: r(51, '%'), water_level_pct: r(64, '%') })
  data.set('light', { on: true, level: 85, since: '' })
  data.set('pump', { on: false, level: 0, remainingS: null, fault: null })
  data.set('grow', { cycle: { stage: 'vegetative', notes: 'greens' }, day: 19 })
  data.set('pods', [{ slot: 1, plant: 'Basil', status: 'growing', notes: 'pinch tops', plantedAt: null, updatedAt: '' }, { slot: 2, plant: null, status: 'empty', notes: '', plantedAt: null, updatedAt: '' }])
  data.set('trends', [{ slot: 1, green: 0.42, verdict: 'growing', slope: 0, samples: 6, recent: [0.3, 0.42] }])
})
afterEach(cleanup)

const pick = (slot: number) => act(() => (tower.props?.onSelect as (s: number) => void)(slot))
const action = () => within(screen.getByTestId('pod-action'))

describe('Home', () => {
  it('puts the cycle\'s day, stage and notes over the tower, with a count per status that adds up to every pod', () => {
    data.set('pods', [
      { slot: 1, plant: 'Basil', status: 'growing', notes: '', plantedAt: null, updatedAt: '' },
      { slot: 2, plant: 'Mint', status: 'seeded', notes: '', plantedAt: null, updatedAt: '' },
      { slot: 3, plant: 'Jalapeño', status: 'harvest', notes: '', plantedAt: null, updatedAt: '' },
      { slot: 9, plant: 'Kale', status: 'attention', notes: 'yellowing leaves', plantedAt: null, updatedAt: '' },
      { slot: 10, plant: null, status: 'empty', notes: '', plantedAt: null, updatedAt: '' },
    ])
    render(<TowerHome onUnavailable={vi.fn()} />)
    const cycle = screen.getByTestId('home-cycle')
    expect(cycle.textContent).toContain('Day 19')
    expect(cycle.textContent).toContain('Vegetative · greens')
    expect(screen.getByTestId('home-counts').textContent).toBe('2 growing1 ready1 attention1 empty')
    expect(tower.props).toMatchObject({ waterPct: 64, lightLevel: 85, pumpOn: false, selected: null, legend: false })
    // No chips, no panel down the right: the sidebar has the readings now.
    expect(screen.queryByRole('button')).toBeNull()
    expect(tower.props?.aside).toBeUndefined()
    expect(tower.props?.status).toBeUndefined()
  })

  it('sends a fresh unit to Grow to start a cycle', () => {
    data.set('grow', { cycle: null, day: null })
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect(screen.getByTestId('home-cycle').textContent).toContain('No cycle')
    expect(screen.getByText(/Start one on Grow/).closest('a')?.getAttribute('href')).toBe('/grow')
  })

  it('names the light and tank on hover, and opens their page on a click', () => {
    data.set('pump', { on: true, level: 80, remainingS: 200, fault: null })
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect(tower.props?.partLabels).toEqual({ light: 'Grow light · 85%', tank: 'Tank · 64% · pump running' })
    act(() => (tower.props?.onPart as (p: string) => void)('light'))
    expect(navigate).toHaveBeenLastCalledWith({ to: '/light' })
    act(() => (tower.props?.onPart as (p: string) => void)('tank'))
    expect(navigate).toHaveBeenLastCalledWith({ to: '/water' })
  })

  it('gives a ready pod "Mark harvested" and its growth history', () => {
    data.set('pods', [{ slot: 2, plant: 'Arugula', status: 'growing', notes: '', plantedAt: null, updatedAt: '', statusSince: null }])
    data.set('harvest', [{ slot: 2, state: 'ready', window: null, cover: 0.43, targetCover: 0.4, daysToReady: null, daysLeft: 6, reason: '' }])
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect((tower.props?.pods as { harvest: unknown }[])[0]?.harvest).toMatchObject({ state: 'ready' })
    pick(2)
    fireEvent.click(action().getByRole('button', { name: 'Mark harvested' }))
    expect(calls.markHarvested).toHaveBeenCalledWith({ slot: 2 })
    const history = action().getByRole('link', { name: 'Growth history' })
    expect(history.getAttribute('href')).toBe('/grow?pod=2')
    expect(history.textContent).toBe('')
  })

  it('gives a pod needing attention its photo and a dismiss that sets it back to growing', () => {
    data.set('pods', [{ slot: 9, plant: 'Kale', status: 'attention', notes: 'yellowing', plantedAt: null, updatedAt: '', statusSince: null }])
    render(<TowerHome onUnavailable={vi.fn()} />)
    pick(9)
    expect(action().queryByRole('button', { name: 'Mark harvested' })).toBeNull()
    expect(action().getByRole('link', { name: 'View photo' }).getAttribute('href')).toBe('/cameras')
    fireEvent.click(action().getByRole('button', { name: 'Dismiss' }))
    expect(calls.updatePod).toHaveBeenCalledWith({ slot: 9, status: 'growing' })
  })

  it('gives a growing pod its growth history, and an empty one a way to plant it', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect(screen.getByTestId('pod-action').textContent).toBe('')
    pick(1)
    expect(action().getByRole('link', { name: 'Growth history' }).textContent).toBe('Growth history')
    pick(2)
    expect(action().getByRole('link', { name: 'Plant on Grow' }).getAttribute('href')).toBe('/grow?pod=2')
  })

  it('gives the tower each pod\'s trend and notes, unpicks on a second click, and closes the callout', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect((tower.props?.pods as unknown[])[0]).toMatchObject({ slot: 1, plant: 'Basil', green: 0.42, verdict: 'growing', recent: [0.3, 0.42], notes: 'pinch tops' })
    pick(1)
    expect(tower.props?.selected).toBe(1)
    pick(1)
    expect(tower.props?.selected).toBeNull()
    pick(1)
    act(() => (tower.props?.onClose as () => void)())
    expect(tower.props?.selected).toBeNull()
  })
})
