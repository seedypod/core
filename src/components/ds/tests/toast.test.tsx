// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Check, Waves } from 'lucide-react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOAST_ANIMATION_MS, TOAST_DURATION_MS, ToastProvider, useToast, type ToastNotice } from '../toast'

const note = (id: string, extra: Partial<ToastNotice> = {}): ToastNotice => ({ id, kind: 'success', tone: 'ok', icon: Check, title: `${id} title`, ...extra })

const api: { show: (n: ToastNotice) => void } = { show: () => {} }
const show = (n: ToastNotice) => api.show(n)
function Grab() {
  const toast = useToast()
  useEffect(() => {
    api.show = toast.show
  })
  return null
}
const mount = (duration?: number) => render(<ToastProvider duration={duration}><Grab /></ToastProvider>)
const shown = () => screen.queryByTestId('toast')?.dataset.toast ?? null
const pass = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms)
})
/** Runs one out and lets it leave: separate steps, as each timer is set once the render before it lands. */
const runOut = (duration: number) => {
  pass(duration)
  pass(TOAST_ANIMATION_MS)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ToastProvider', () => {
  it('lasts six seconds by default', () => {
    expect(TOAST_DURATION_MS).toBe(6000)
  })

  it('shows one at a time, the next after the first has gone', () => {
    mount()
    act(() => {
      show(note('a'))
      show(note('b'))
    })
    expect(shown()).toBe('a')
    pass(TOAST_DURATION_MS - 1)
    expect(shown()).toBe('a')
    pass(1)
    expect(screen.getByTestId('toast').dataset.leaving).toBe('true')
    pass(TOAST_ANIMATION_MS)
    expect(shown()).toBe('b')
    runOut(TOAST_DURATION_MS)
    expect(shown()).toBeNull()
  })

  it('replaces the one up when the same id shows again, restarting its countdown', () => {
    mount()
    act(() => show(note('a')))
    pass(4000)
    act(() => show(note('a', { title: 'again' })))
    expect(screen.getByText('again')).toBeTruthy()
    pass(4000)
    expect(screen.getByTestId('toast').dataset.leaving).toBeUndefined()
  })

  it('updates a queued one in place rather than queueing it twice', () => {
    mount(1000)
    act(() => {
      show(note('a'))
      show(note('b'))
      show(note('b', { title: 'b newer' }))
    })
    runOut(1000)
    expect(screen.getByText('b newer')).toBeTruthy()
    runOut(1000)
    expect(shown()).toBeNull()
  })

  it('pauses while hovered or focused, then runs out the rest', () => {
    mount(1000)
    act(() => show(note('a')))
    pass(600)
    fireEvent.mouseEnter(screen.getByTestId('toast'))
    pass(5000)
    expect(screen.getByTestId('toast').dataset.leaving).toBeUndefined()
    expect(screen.getByTestId('toast-countdown').style.animationPlayState).toBe('paused')
    fireEvent.mouseLeave(screen.getByTestId('toast'))
    pass(399)
    expect(screen.getByTestId('toast').dataset.leaving).toBeUndefined()
    pass(1)
    expect(screen.getByTestId('toast').dataset.leaving).toBe('true')
  })

  it('pauses while its button has focus', () => {
    mount(1000)
    act(() => show(note('a', { action: { label: 'Undo', onClick: () => {} } })))
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }))
    pass(3000)
    expect(screen.getByTestId('toast').dataset.leaving).toBeUndefined()
    fireEvent.blur(screen.getByRole('button', { name: 'Undo' }))
    pass(1000)
    expect(screen.getByTestId('toast').dataset.leaving).toBe('true')
  })

  it('runs its action once and goes', () => {
    const undo = vi.fn()
    mount()
    act(() => show(note('a', { action: { label: 'Undo', onClick: undo } })))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledOnce()
    expect(screen.getByTestId('toast').dataset.leaving).toBe('true')
    pass(TOAST_ANIMATION_MS)
    expect(shown()).toBeNull()
  })

  it('has no action button without an action, and an X that dismisses it', () => {
    mount()
    act(() => show(note('a')))
    expect(screen.queryByTestId('toast-action')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    pass(TOAST_ANIMATION_MS)
    expect(shown()).toBeNull()
  })

  it('keeps a polite and an assertive region mounted, and puts each toast in its own', () => {
    mount(1000)
    const status = screen.getByRole('status')
    const alert = screen.getByRole('alert')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(alert.getAttribute('aria-live')).toBe('assertive')
    expect(status.textContent).toBe('')
    expect(alert.textContent).toBe('')
    act(() => show(note('a', { detail: 'all good' })))
    expect(status.textContent).toContain('all good')
    expect(alert.textContent).toBe('')
    runOut(1000)
    act(() => show(note('pump', { tone: 'danger', icon: Waves, urgent: true, title: 'Pump stopped: dry-run' })))
    // The same elements as before: neither region was swapped out to change its politeness.
    expect(screen.getByRole('alert')).toBe(alert)
    expect(alert.textContent).toContain('Pump stopped: dry-run')
    expect(status.textContent).toBe('')
  })

  it('does nothing outside a provider', () => {
    api.show = () => {}
    render(<Grab />)
    expect(() => show(note('a'))).not.toThrow()
    expect(shown()).toBeNull()
  })
})
