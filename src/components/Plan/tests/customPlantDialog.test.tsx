// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CustomPlantDialog, type EditablePlant } from '../CustomPlantDialog'

const { calls, invalidate, state } = vi.hoisted(() => ({
  calls: { add: vi.fn(), update: vi.fn(), remove: vi.fn() },
  invalidate: vi.fn(),
  state: { error: null as null | { message: string }, succeed: true },
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (fn: (i: unknown) => void, key: 'add' | 'update' | 'remove') => ({
    useMutation: (o?: { onSuccess?: () => void }) => ({
      isPending: false,
      error: key === 'add' ? state.error : null,
      mutate: (input: unknown) => {
        fn(input)
        if (state.succeed) o?.onSuccess?.()
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ planner: { invalidate } }),
      planner: { addPlant: mutation(calls.add, 'add'), updatePlant: mutation(calls.update, 'update'), removePlant: mutation(calls.remove, 'remove') },
    },
  }
})

beforeEach(() => {
  state.error = null
  state.succeed = true
  for (const f of [...Object.values(calls), invalidate]) f.mockReset()
})
afterEach(cleanup)

const okra: EditablePlant = { id: 'okra', name: 'Okra', category: 'fruiting', zone: 'high', harvestMonths: [2, 3], careLevel: 'expert', size: 'large' }

describe('CustomPlantDialog', () => {
  it('renders nothing while closed', () => {
    render(<CustomPlantDialog open={false} plant={null} onClose={() => undefined} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('adds a plant with every field, and only once the form is valid', () => {
    const onClose = vi.fn()
    render(<CustomPlantDialog open plant={null} onClose={onClose} />)
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Okra' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'fruiting' } })
    fireEvent.change(screen.getByLabelText('Care level'), { target: { value: 'beginner' } })
    fireEvent.click(screen.getByRole('tab', { name: 'High' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Large · spaced apart' }))
    fireEvent.change(screen.getByLabelText('First harvest from (months)'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('to (months)'), { target: { value: '3' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('to (months)'), { target: { value: '5' } })
    expect(add.disabled).toBe(false)
    fireEvent.click(add)
    expect(calls.add).toHaveBeenCalledWith({ name: 'Okra', category: 'fruiting', zone: 'high', harvestMonths: [4, 5], careLevel: 'beginner', size: 'large', tolerates: null })
    expect(invalidate).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('edits a plant from its current values, clears its care level, and deletes it', () => {
    render(<CustomPlantDialog open plant={okra} onClose={() => undefined} />)
    expect(screen.getByText('Edit Okra')).toBeTruthy()
    expect((screen.getByLabelText('Care level') as HTMLSelectElement).value).toBe('expert')
    fireEvent.change(screen.getByLabelText('Care level'), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Normal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.update).toHaveBeenCalledWith({ id: 'okra', name: 'Okra', category: 'fruiting', zone: 'high', harvestMonths: [2, 3], careLevel: null, size: 'normal', tolerates: null })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(calls.remove).toHaveBeenCalledWith({ id: 'okra' })
  })

  it('shows the zones a plant also does ok in, its category’s until you pick your own', () => {
    render(<CustomPlantDialog open plant={null} onClose={() => undefined} />)
    const zone = (name: string) => screen.getByRole('button', { name })
    // A medium herb: one zone either way.
    expect([zone('High').getAttribute('aria-pressed'), zone('Low').getAttribute('aria-pressed')]).toEqual(['true', 'true'])
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'lettuce' } })
    expect([zone('High').getAttribute('aria-pressed'), zone('Low').getAttribute('aria-pressed')]).toEqual(['false', 'true'])
    expect(screen.queryByRole('button', { name: 'Category default' })).toBeNull()

    fireEvent.click(zone('High'))
    fireEvent.click(zone('Low'))
    expect([zone('High').getAttribute('aria-pressed'), zone('Low').getAttribute('aria-pressed')]).toEqual(['true', 'false'])
    // Moving its own zone to high drops high from the rest.
    fireEvent.click(screen.getByRole('tab', { name: 'High' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tall lettuce' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(calls.add).toHaveBeenLastCalledWith(expect.objectContaining({ zone: 'high', tolerates: [] }))

    fireEvent.click(zone('Category default'))
    expect(screen.queryByRole('button', { name: 'Category default' })).toBeNull()
  })

  it('keeps a plant’s own zones when editing, and goes back to the default on request', () => {
    const own: EditablePlant = { ...okra, tolerates: [{ zone: 'low' }] }
    render(<CustomPlantDialog open plant={own} onClose={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Low' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Medium' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.update).toHaveBeenLastCalledWith(expect.objectContaining({ tolerates: ['low'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Category default' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.update).toHaveBeenLastCalledWith(expect.objectContaining({ tolerates: null }))
    cleanup()

    // Saved with its category's own zones: they keep following its category.
    render(<CustomPlantDialog open plant={{ ...okra, tolerates: [{ zone: 'medium' }] }} onClose={() => undefined} />)
    expect(screen.queryByRole('button', { name: 'Category default' })).toBeNull()
    cleanup()

    // Saved with none: kept to its own zone.
    render(<CustomPlantDialog open plant={{ ...okra, tolerates: [] }} onClose={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Medium' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Category default' })).toBeTruthy()
  })

  it('shows why the unit refused, and cancels', () => {
    state.error = { message: 'Basil is already in the catalog (basil, built-in)' }
    state.succeed = false
    const onClose = vi.fn()
    render(<CustomPlantDialog open plant={null} onClose={onClose} />)
    expect(screen.getByText('Basil is already in the catalog (basil, built-in)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
