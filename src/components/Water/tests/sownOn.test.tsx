// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SownOn } from '../SownOn'

afterEach(cleanup)

const props = { sowDate: '2026-11-09', cycle: 'open' as const, today: '2026-11-11', onChange: vi.fn(async () => undefined), onStartToday: vi.fn() }

describe('SownOn', () => {
  it('opens Change on the sowing day, between 120 days back and today, and closes once the move lands', async () => {
    let land: () => void = () => {}
    const onChange = vi.fn(() => new Promise<void>((resolve) => {
      land = resolve
    }))
    render(<SownOn {...props} onChange={onChange} />)
    expect(screen.getByTestId('sown-on').textContent).toBe('Sown Mon 9 Nov')
    fireEvent.click(screen.getByText('Change'))
    const input = screen.getByLabelText(/Sown on/) as HTMLInputElement
    expect(input.value).toBe('2026-11-09')
    expect(input.max).toBe('2026-11-11')
    expect(input.min).toBe('2026-07-14')
    fireEvent.change(input, { target: { value: '2026-11-12' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '2026-07-13' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '2026-11-10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onChange).toHaveBeenCalledWith('2026-11-10')
    // Open, and busy, until it settles.
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy()
    await act(async () => land())
    expect(screen.queryByLabelText(/Sown on/)).toBeNull()
    expect(screen.getByTestId('sown-on')).toBeTruthy()
  })

  it('keeps the chosen date and says why when the move fails, and forgets it on Cancel', async () => {
    const onChange = vi.fn(async () => {
      throw new Error('startedAt 2026-11-10 is after today (2026-11-09)')
    })
    render(<SownOn {...props} onChange={onChange} />)
    fireEvent.click(screen.getByText('Change'))
    fireEvent.change(screen.getByLabelText(/Sown on/), { target: { value: '2026-11-10' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(screen.getByRole('alert').textContent).toBe('startedAt 2026-11-10 is after today (2026-11-09)')
    expect((screen.getByLabelText(/Sown on/) as HTMLInputElement).value).toBe('2026-11-10')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByText('Change'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers Start germination today only once the unit says there is no cycle', () => {
    const onStartToday = vi.fn()
    const { rerender } = render(<SownOn {...props} cycle="unknown" onStartToday={onStartToday} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('sown-on')).toBeNull()
    rerender(<SownOn {...props} cycle="none" onStartToday={onStartToday} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start germination today' }))
    expect(onStartToday).toHaveBeenCalled()
    expect(screen.queryByText('Change')).toBeNull()
  })

  it('shows nothing to change without a sowing date, and says why the weekly run stays', () => {
    const { rerender } = render(<SownOn {...props} sowDate={null} />)
    expect(screen.queryByTestId('sown-on')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<SownOn {...props} note="Follow is off: your weekly run stays on Mondays" />)
    expect(screen.getByTestId('sown-note').textContent).toBe('Follow is off: your weekly run stays on Mondays')
  })
})
