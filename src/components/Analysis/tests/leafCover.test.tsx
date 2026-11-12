// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeafCover } from '../LeafCover'

const q = vi.hoisted(() => ({
  pods: { data: undefined as unknown, error: null as Error | null, refetch: vi.fn() },
  trends: { data: undefined as unknown, error: null as Error | null, refetch: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    grow: { pods: { useQuery: () => q.pods } },
    vision: { podTrends: { useQuery: () => q.trends } },
  },
}))

const pod = (slot: number, status = 'growing') => ({ slot, status, plant: status === 'empty' ? null : 'Basil' })

beforeEach(() => {
  q.pods = { data: Array.from({ length: 30 }, (_, i) => pod(i + 1, i % 5 === 0 ? 'empty' : 'growing')), error: null, refetch: vi.fn() }
  q.trends = { data: [{ slot: 2, green: 0.42 }, { slot: 3, green: 0.1 }, { slot: 12, green: 0.9 }, { slot: 1, green: 0.5 }], error: null, refetch: vi.fn() }
})
afterEach(cleanup)

describe('LeafCover', () => {
  it('says what the spheres mean, shows the latest frame\'s time, and without WebGL draws a bar per pod', () => {
    render(<LeafCover capturedAt="2026-11-10T08:00:00Z" />)
    const card = screen.getByRole('region', { name: 'Leaf cover per pod' })
    // Pod 1 is empty (as are 6, 11, …), so its reading doesn't count.
    expect(within(card).getByText('Sphere size is leaf cover from the latest frame. Grey pods are empty.')).toBeTruthy()
    expect(within(card).getByTestId('leaf-cover-frame').textContent).toBeTruthy()
    const flat = within(card).getByTestId('leaf-cover-flat')
    expect(within(flat).getByText('TOWER 1')).toBeTruthy()
    expect(within(flat).getByText('TOWER 3')).toBeTruthy()
    expect(within(flat).getByText('42%')).toBeTruthy()
    expect(within(flat).getByText('90%')).toBeTruthy()
    expect(within(flat).queryByText('50%')).toBeNull()
    expect(within(flat).getAllByText('—')).toHaveLength(27)
  })

  it('says it is loading until both requests answer', () => {
    q.trends.data = undefined
    render(<LeafCover capturedAt={null} />)
    expect(screen.getByTestId('loading-line')).toBeTruthy()
  })

  it('offers Retry when the pods fail to load', () => {
    q.pods = { data: undefined, error: new Error('down'), refetch: vi.fn() }
    render(<LeafCover capturedAt={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(q.pods.refetch).toHaveBeenCalled()
    expect(q.trends.refetch).toHaveBeenCalled()
  })
})
