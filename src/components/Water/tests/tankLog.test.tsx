// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeAction, TankLog } from '../TankLog'

const { data, calls, state } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { logAction: vi.fn(), removeAction: vi.fn(), invalidate: vi.fn() },
  state: { error: null as null | { message: string } },
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (name: 'logAction' | 'removeAction') => ({
    useMutation: (o: { onSuccess: () => void }) => ({
      error: name === 'logAction' ? state.error : null,
      mutate: (i: unknown) => {
        calls[name](i)
        o.onSuccess()
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ tank: { invalidate: calls.invalidate } }),
      tank: { actions: { useQuery: () => ({ data: data.get('actions') }) }, logAction: mutation('logAction'), removeAction: mutation('removeAction') },
    },
  }
})

const at = (h: number, d = 9) => new Date(2026, 10, d, h).toISOString()
const action = (id: number, extra: Record<string, unknown>) => ({ id, ts: at(9), kind: 'feed', amount: null, unit: null, product: null, note: '', source: 'user', createdAt: at(9), ...extra })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 9, 12))
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  state.error = null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('describeAction', () => {
  it('reads each kind as a short sentence', () => {
    expect(describeAction({ kind: 'feed', amount: 1, unit: 'tsp', product: 'MaxiGro', note: '' })).toBe('Fed 1 tsp MaxiGro')
    expect(describeAction({ kind: 'feed', amount: null, unit: null, product: null, note: '' })).toBe('Fed')
    expect(describeAction({ kind: 'ph_down', amount: 2, unit: 'mL', product: null, note: '' })).toBe('Added pH Down 2 mL')
    expect(describeAction({ kind: 'ph_up', amount: 1, unit: 'mL', product: 'GH pH Up', note: '' })).toBe('Added pH Up 1 mL · GH pH Up')
    expect(describeAction({ kind: 'top_off', amount: 3, unit: 'L', product: null, note: '' })).toBe('Topped off 3 L')
    expect(describeAction({ kind: 'other', amount: null, unit: null, product: null, note: ' Swapped the pump filter ' })).toBe('Swapped the pump filter')
    expect(describeAction({ kind: 'other', amount: 5, unit: 'mL', product: 'CalMag', note: '' })).toBe('Other 5 mL · CalMag')
  })
})

describe('TankLog', () => {
  it('says what to log when nothing is', () => {
    render(<TankLog />)
    expect(screen.getByText(/Nothing logged yet/)).toBeTruthy()
  })

  it('lists entries with when, an agent mark and their note, and removes one', () => {
    data.set('actions', [
      action(2, { kind: 'ph_down', amount: 2, unit: 'mL', note: 'pH read 6.9', source: 'agent' }),
      action(1, { ts: at(18, 8), amount: 1, unit: 'tsp', product: 'MaxiGro' }),
    ])
    render(<TankLog />)
    const log = within(screen.getByTestId('tank-log'))
    expect(log.getByText('Added pH Down 2 mL')).toBeTruthy()
    expect(log.getByText('pH read 6.9')).toBeTruthy()
    expect(log.getByText('agent')).toBeTruthy()
    expect(log.getByText('Today 09:00')).toBeTruthy()
    expect(log.getByText('Yesterday 18:00')).toBeTruthy()
    fireEvent.click(log.getByRole('button', { name: 'Remove Fed 1 tsp MaxiGro' }))
    expect(calls.removeAction).toHaveBeenCalledWith({ id: 1 })
    expect(calls.invalidate).toHaveBeenCalled()
  })

  it('logs a feed with its amount, unit and product', () => {
    render(<TankLog />)
    fireEvent.click(screen.getByRole('button', { name: 'Log action' }))
    fireEvent.change(screen.getByLabelText('Amount (optional)'), { target: { value: '1,5' } })
    fireEvent.change(screen.getByLabelText('Product (optional)'), { target: { value: ' MaxiGro ' } })
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'pre-dissolved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.logAction).toHaveBeenCalledWith({ kind: 'feed', amount: 1.5, unit: 'tsp', product: 'MaxiGro', note: 'pre-dissolved' })
    expect(screen.queryByText('Log a tank action')).toBeNull()
  })

  it('switches the unit with the kind, and logs one without an amount as just the action', () => {
    render(<TankLog />)
    fireEvent.click(screen.getByRole('button', { name: 'Log action' }))
    fireEvent.change(screen.getByLabelText('What was done'), { target: { value: 'ph_down' } })
    expect((screen.getByLabelText('Unit') as HTMLSelectElement).value).toBe('mL')
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'tsp' } })
    fireEvent.change(screen.getByLabelText('What was done'), { target: { value: 'clean' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.logAction).toHaveBeenCalledWith({ kind: 'clean', amount: null, unit: null, product: null, note: '' })
  })

  it('won\'t save an amount that isn\'t a number above 0, and cancels', () => {
    render(<TankLog />)
    fireEvent.click(screen.getByRole('button', { name: 'Log action' }))
    fireEvent.change(screen.getByLabelText('Amount (optional)'), { target: { value: 'lots' } })
    expect(screen.getByText('A number above 0')).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(calls.logAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Log a tank action')).toBeNull()
  })

  it('shows why a save failed', () => {
    state.error = { message: '2026-12-01 is in the future' }
    render(<TankLog />)
    expect(screen.getByText('2026-12-01 is in the future')).toBeTruthy()
  })
})
