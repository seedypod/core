// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Charts from '@/src/components/charts/viz3d/Chart3D'
import type { ChartPick } from '@/src/components/charts/viz3d/Chart3D'
import { LeafCover, spotLeft } from '../LeafCover'
import type { PodStory } from '../pods'

const q = vi.hoisted(() => ({
  pods: { data: undefined as unknown, error: null as Error | null, refetch: () => {} },
  trends: { data: undefined as unknown, error: null as Error | null, refetch: () => {} },
  pick: null as ChartPick | null,
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    grow: { pods: { useQuery: () => q.pods } },
    vision: { podTrends: { useQuery: () => q.trends } },
  },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, ...rest }: { children: ReactNode, to: string, search?: { pod: number } }) => <a href={search ? `${to}?pod=${search.pod}` : to} {...rest}>{children}</a>,
}))
// The towers as the page sees them: what LeafCover hands the chart to pick with.
vi.mock('@/src/components/charts/viz3d/Chart3D', async (actual) => {
  const real = await actual<typeof Charts>()
  return {
    ...real,
    Chart3D: ({ pick }: { pick: ChartPick }) => {
      q.pick = pick
      return <div data-testid="viz-pods" />
    },
  }
})

const story = (stage: PodStory['state']['stage']): PodStory => ({ state: { stage, from: 'record', at: null, by: null, confidence: null }, day: 8, window: null, sprout: null, code: null })
const stories = new Map<number, PodStory>([[2, story('growing')], [3, story('sprouted')], [1, story('empty')]])

beforeEach(() => {
  q.pods = { data: [{ slot: 1, status: 'empty', plant: null, plantedAt: null, notes: '' }, { slot: 2, status: 'growing', plant: 'Basil', plantedAt: '2026-11-01', notes: '' }, { slot: 3, status: 'seeded', plant: 'Mint', plantedAt: '2026-11-09', notes: '' }], error: null, refetch: () => {} }
  q.trends = { data: [{ slot: 2, green: 0.42, verdict: 'growing', slope: 0.01, samples: 3, recent: [0.3, 0.42] }], error: null, refetch: () => {} }
  q.pick = null
})
afterEach(cleanup)

const spot = { x: 100, y: 80, width: 600, height: 250 }

describe('picking a pod on the towers', () => {
  it('names each pod for a keyboard as its photo box does, and picks through the page', () => {
    const onPick = vi.fn()
    render(<LeafCover capturedAt={null} stories={stories} pinned={null} onPick={onPick} onUnpin={() => {}} onRelabel={() => {}} />)
    const pick = q.pick as ChartPick
    expect(pick.points).toEqual([
      { id: 1, label: 'Pod 1, empty' },
      { id: 2, label: 'Pod 2, Basil, growing, 42% leaf cover' },
      { id: 3, label: 'Pod 3, Mint, sprouted' },
    ])
    expect(pick.pinned).toBeNull()
    pick.onPick(2)
    expect(onPick).toHaveBeenCalledWith(2)
  })

  /** LeafCover with `pinned`, and the card it hands the chart for pod 2 at `spot`. */
  function cardFor(pinned: number | null, on: { onUnpin?: () => void, onRelabel?: () => void } = {}) {
    render(<LeafCover capturedAt={null} stories={stories} pinned={pinned} onPick={() => {}} onUnpin={on.onUnpin ?? (() => {})} onRelabel={on.onRelabel ?? (() => {})} />)
    render(<>{q.pick?.card(2, spot)}</>)
    return screen.getByRole('dialog', { name: 'Pod 2' })
  }

  it('opens the pod\'s card beside its spot, in the flow of its place there, with relabel', () => {
    const onRelabel = vi.fn()
    const card = cardFor(null, { onRelabel })
    expect(within(card).getByText('Basil')).toBeTruthy()
    expect(within(card).getByText('Growing')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Close' })).toBeNull()
    expect(card.className).toContain('shrink-0')
    expect(card.className).not.toContain('absolute')
    const place = screen.getByTestId('spot-card')
    expect(place.style.left).toBe('112px')
    expect(place.style.width).toBe('238px')
    // The space above and below the card, in proportion to the pod's height on the chart.
    const [above, below] = [place.firstElementChild as HTMLElement, place.lastElementChild as HTMLElement]
    expect([above.style.flex, below.style.flex]).toEqual(['0 1 80px', '0 1 170px'])
    fireEvent.click(within(card).getByRole('button', { name: 'Relabel' }))
    expect(onRelabel).toHaveBeenCalled()
  })

  it('closes a pinned pod\'s card through the page', () => {
    const onUnpin = vi.fn()
    fireEvent.click(within(cardFor(2, { onUnpin })).getByRole('button', { name: 'Close' }))
    expect(onUnpin).toHaveBeenCalled()
  })

  it('places the card right of a pod in the chart\'s left half and left of one in its right half, kept inside', () => {
    expect(spotLeft(spot)).toBe(112)
    expect(spotLeft({ ...spot, x: 500 })).toBe(250)
    // Near an edge, the card stops at it.
    expect(spotLeft({ ...spot, x: 290 })).toBe(302)
    expect(spotLeft({ ...spot, x: 420 })).toBe(170)
    expect(spotLeft({ ...spot, x: 590 })).toBe(340)
    expect(spotLeft({ x: 250, y: 50, width: 300, height: 125 })).toBe(0)
    expect(spotLeft({ x: 40, y: 50, width: 300, height: 125 })).toBe(52)
    expect(spotLeft({ x: 140, y: 50, width: 300, height: 125 })).toBe(62)
  })
})
