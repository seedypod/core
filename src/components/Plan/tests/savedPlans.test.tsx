// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedPlan } from '../planSummary'
import { SavedPlans, UNDO_MS } from '../SavedPlans'

const ids = ['basil', 'italian-parsley', 'chives', 'catnip', 'cilantro', 'green-bok-choy', 'kale', 'kale-lacinato', 'perpetual-spinach']
const order: SavedPlan = {
  id: 'order', name: 'Order Y221288628', model: 'home', appliedAt: null,
  request: ids.map(plantId => ({ plantId, count: plantId === 'perpetual-spinach' ? 2 : 1 })),
  layout: {
    assignments: ids.slice(0, 4).map((plantId, i) => ({ slot: 25 + i, plantId, plantName: plantId })),
    unplaced: [{ plantId: 'kale', plantName: 'Kale' }, { plantId: 'perpetual-spinach', plantName: 'Perpetual Spinach' }],
  },
  sowing: [{ plantId: 'basil', sowOn: '2026-11-09' }, { plantId: 'italian-parsley', sowOn: '2026-11-09' }, { plantId: 'chives', sowOn: '2026-11-09' }, { plantId: 'catnip', sowOn: '2026-12-20' }],
  createdAt: '2026-11-09T08:00:00Z',
  updatedAt: '2026-11-09T08:00:00Z',
}
const catalog = [{ id: 'basil', name: 'Basil' }, { id: 'italian-parsley', name: 'Italian Parsley' }, { id: 'chives', name: 'Chives' }, { id: 'catnip', name: 'Catnip' }, { id: 'cilantro', name: 'Cilantro' }, { id: 'green-bok-choy', name: 'Green Bok Choy' }]

const props = () => ({ plans: [order], catalog, editing: null, onOpen: vi.fn(), onApply: vi.fn(), onRemove: vi.fn(), now: () => new Date('2026-11-09T12:00:00Z') })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SavedPlans', () => {
  it('sums a plan up by plant name, with counts, unplaced in amber, and the rest behind "+N more"', () => {
    render(<SavedPlans {...props()} />)
    const card = within(screen.getByRole('group', { name: 'Order Y221288628' }))
    expect(card.getByTestId('plan-meta').textContent).toMatch(/^Gardyn Home·4 of 30 pods·2 unplaced·Saved /)
    expect(card.getByText('2 unplaced').className).toContain('text-warn')
    const chips = () => card.getAllByRole('listitem').map(li => li.textContent)
    expect(chips()).toEqual(['Basil', 'Italian Parsley', 'Chives', 'Catnip', 'Cilantro', 'Green Bok Choy', '+3 more'])
    expect(card.getAllByTestId('plant-thumb')).toHaveLength(6)
    fireEvent.click(card.getByRole('button', { name: '+3 more' }))
    expect(chips().slice(6)).toEqual(['Kale', 'Kale Lacinato', 'Perpetual Spinach×2', 'Show fewer'])
    expect(chips().join(' ')).not.toMatch(/[a-z]-[a-z]/)
    fireEvent.click(card.getByRole('button', { name: 'Show fewer' }))
    expect(chips()).toHaveLength(7)
  })

  it('opens a plan in the planner, and marks the one being edited', () => {
    const p = props()
    const { rerender } = render(<SavedPlans {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in planner' }))
    expect(p.onOpen).toHaveBeenCalledWith(order)
    rerender(<SavedPlans {...p} editing="order" />)
    expect(screen.getByText('editing')).toBeTruthy()
  })

  it('says what applying does before it applies', () => {
    const p = props()
    render(<SavedPlans {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply to tower' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('Apply “Order Y221288628” to your tower?')).toBeTruthy()
    expect(dialog.getByText('3 pods marked seeded today.')).toBeTruthy()
    expect(dialog.getByText(/^1 pod kept for a later wave with its sow date; you’ll get a reminder when each is due \(next .+\)\.$/)).toBeTruthy()
    expect(dialog.getByText('2 pods that didn’t fit are left out.')).toBeTruthy()
    expect(dialog.getByText('Pods the plan uses lose what they hold now; the rest stay as they are.')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Apply to tower' }))
    expect(p.onApply).toHaveBeenCalledWith('order')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('takes a delete back with Undo, and otherwise removes the plan once the undo lapses', () => {
    const p = props()
    render(<SavedPlans {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Order Y221288628' }))
    expect(screen.queryByRole('group', { name: 'Order Y221288628' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    act(() => vi.advanceTimersByTime(UNDO_MS))
    expect(p.onRemove).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Order Y221288628' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Order Y221288628' }))
    act(() => vi.advanceTimersByTime(UNDO_MS - 1))
    expect(p.onRemove).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(p.onRemove).toHaveBeenCalledWith('order')
    expect(screen.queryByText(/^Deleted/)).toBeNull()
  })

  it('removes a plan still waiting on its undo when the page closes', () => {
    const p = props()
    const { unmount } = render(<SavedPlans {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Order Y221288628' }))
    unmount()
    expect(p.onRemove).toHaveBeenCalledWith('order')
  })

  it('says how to start when there are no plans', () => {
    render(<SavedPlans {...props()} plans={[]} />)
    expect(screen.getByText(/Pick plants above, then save a plan/)).toBeTruthy()
  })
})
