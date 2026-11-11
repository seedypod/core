// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fmtCalendarDate, SownOn } from '../SownOn'

afterEach(cleanup)

const props = { sowDate: '2026-11-09', open: true, today: '2026-11-11', busy: false, error: null, onChange: vi.fn(), onStartToday: vi.fn() }

describe('SownOn', () => {
  it('writes a calendar date as the unit reads it', () => {
    expect(fmtCalendarDate('2026-11-09')).toBe('Mon 9 Nov')
    expect(fmtCalendarDate('2027-01-01')).toBe('Fri 1 Jan')
  })

  it('changes the sowing day to one no later than today, or cancels', () => {
    const onChange = vi.fn()
    render(<SownOn {...props} onChange={onChange} />)
    expect(screen.getByTestId('sown-on').textContent).toBe('Sown Mon 9 Nov')
    fireEvent.click(screen.getByText('Change'))
    const input = screen.getByLabelText(/Sown on/) as HTMLInputElement
    expect(input.value).toBe('2026-11-11')
    expect(input.max).toBe('2026-11-11')
    fireEvent.change(input, { target: { value: '2026-11-12' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '2026-11-10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onChange).toHaveBeenCalledWith('2026-11-10')
    expect(screen.getByTestId('sown-on')).toBeTruthy()
    fireEvent.click(screen.getByText('Change'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('offers to start germination today with no grow cycle, and says why a change failed', () => {
    const onStartToday = vi.fn()
    render(<SownOn {...props} open={false} onStartToday={onStartToday} error="No open grow cycle to move; start one" />)
    fireEvent.click(screen.getByRole('button', { name: 'Start germination today' }))
    expect(onStartToday).toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('No open grow cycle to move; start one')
    expect(screen.queryByText('Change')).toBeNull()
  })

  it('shows nothing to change with an open cycle but no sowing date to show', () => {
    render(<SownOn {...props} sowDate={null} />)
    expect(screen.queryByTestId('sown-on')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
