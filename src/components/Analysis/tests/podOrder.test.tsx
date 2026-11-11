// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orderSummary, PodOrder } from '../PodOrder'

const { state, calls, invalidate } = vi.hoisted(() => ({
  state: { data: undefined as unknown, pending: false, error: null as null | { message: string } },
  calls: { fix: vi.fn() },
  invalidate: { vision: vi.fn(), grow: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ vision: { invalidate: invalidate.vision }, grow: { invalidate: invalidate.grow } }),
    vision: {
      podOrder: { useQuery: () => ({ data: state.data }) },
      fixPodOrder: { useMutation: (o: { onSuccess: () => void }) => ({ isPending: state.pending, error: state.error, mutate: (v: unknown) => {
        calls.fix(v)
        o.onSuccess()
      } }) },
    },
  },
}))

const swapped = {
  slots: [{ slot: 2, code: 'oo||', tower: 'Basil', record: 'Thyme', plan: 'Thyme' }, { slot: 7, code: 'o|hh', tower: 'Thyme', record: 'Basil', plan: 'Basil' }],
  recordSwaps: [[2, 7]],
  recordsUnresolved: [],
  moves: [[2, 7]],
  movesUnresolved: [],
  plan: { id: 'p1', name: 'Autumn' },
  unknown: 13,
  key: 'k1',
}

beforeEach(() => {
  state.data = undefined
  state.pending = false
  state.error = null
  calls.fix.mockClear()
  invalidate.vision.mockClear()
  invalidate.grow.mockClear()
})
afterEach(cleanup)

describe('PodOrder (#224)', () => {
  it('shows nothing when every pod matches', () => {
    const { container } = render(<PodOrder />)
    expect(container.innerHTML).toBe('')
  })

  it('lists the pods and both fixes as one item', () => {
    state.data = swapped
    render(<PodOrder />)
    expect(screen.getByTestId('order-2').textContent).toBe('Pod 2 holds Basil by its code · the record says Thyme · the plan says Thyme')
    expect(screen.getByTestId('fix-records').textContent).toContain('Swap the records of pod 2 ↔ pod 7. Each plant keeps its sowing date and status.')
    expect(screen.getByTestId('fix-moves').textContent).toContain('Move the pods to match Autumn')
    expect(screen.getByTestId('fix-moves').textContent).toContain('On the tower, swap pod 2 ↔ pod 7, then read the codes again.')
    expect(screen.getByText('13 pods without a confirmed code are left alone.')).toBeTruthy()
    expect(orderSummary(swapped as never)).toBe('Pods 2, 7 don\'t match their dot codes')
  })

  it('changes the records only after a second, explicit yes', () => {
    state.data = swapped
    render(<PodOrder />)
    const records = screen.getByTestId('fix-records')
    fireEvent.click(within(records).getByRole('button', { name: 'Update records' }))
    expect(calls.fix).not.toHaveBeenCalled()
    fireEvent.click(within(records).getByRole('button', { name: 'Cancel' }))
    expect(calls.fix).not.toHaveBeenCalled()
    fireEvent.click(within(records).getByRole('button', { name: 'Update records' }))
    fireEvent.click(within(records).getByRole('button', { name: 'Yes, update the records' }))
    expect(calls.fix).toHaveBeenCalledWith({ key: 'k1' })
    expect(invalidate.vision).toHaveBeenCalled()
    expect(invalidate.grow).toHaveBeenCalled()
  })

  it('says what neither fix can settle, and that with no plan there is nothing to move to', () => {
    state.data = { ...swapped, slots: [{ slot: 9, code: 'oo||', tower: 'Basil', record: 'Kale', plan: null }], recordSwaps: [], recordsUnresolved: [9], moves: [], movesUnresolved: [], plan: null, unknown: 1 }
    render(<PodOrder />)
    expect(screen.getByTestId('order-9').textContent).toBe('Pod 9 holds Basil by its code · the record says Kale')
    expect(screen.getByText('No swap of records fixes this.')).toBeTruthy()
    expect(screen.getByText('Pod 9: no other read pod\'s record has that plant, so these stay as they are.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update records' })).toBeNull()
    expect(screen.getByText('No plan has been applied, so there is nothing to move them to.')).toBeTruthy()
    expect(screen.getByText('1 pod without a confirmed code is left alone.')).toBeTruthy()
  })

  it('names a plan pod no swap on the tower can fill', () => {
    state.data = { ...swapped, moves: [], movesUnresolved: [2, 7], slots: swapped.slots.map(s => ({ ...s, record: null })) }
    render(<PodOrder />)
    expect(screen.getByText('No swap on the tower fixes this.')).toBeTruthy()
    expect(screen.getByText('Pods 2, 7: the plant the plan puts there isn\'t in another read pod.')).toBeTruthy()
    expect(screen.getByTestId('order-2').textContent).toContain('the record says nothing')
  })

  it('shows a refused fix', () => {
    state.data = swapped
    state.error = { message: 'what\'s out of order has changed since it was shown; look again' }
    render(<PodOrder />)
    expect(screen.getByText('what\'s out of order has changed since it was shown; look again')).toBeTruthy()
  })
})
