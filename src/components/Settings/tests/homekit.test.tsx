// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeKitSection } from '../HomeKitSection'

const { state, calls } = vi.hoisted(() => ({
  state: { status: undefined as unknown, pending: false, setError: null as null | { message: string }, refetch: null as null | ((q: { state: { data: unknown } }) => number | false) },
  calls: { setEnabled: vi.fn(), reset: vi.fn(), invalidate: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ homekit: { invalidate: calls.invalidate } }),
    homekit: {
      status: {
        useQuery: (_: unknown, opts: { refetchInterval: (q: { state: { data: unknown } }) => number | false }) => {
          state.refetch = opts.refetchInterval
          return { data: state.status }
        },
      },
      setEnabled: {
        useMutation: (o: { onSuccess: () => void }) => ({
          isPending: state.pending,
          error: state.setError,
          mutate: (i: unknown) => {
            calls.setEnabled(i)
            o.onSuccess()
          },
        }),
      },
      resetPairing: { useMutation: () => ({ isPending: false, error: null, mutate: () => calls.reset() }) },
    },
  },
}))

const base = { available: true, enabled: false, running: false, transitioning: false, setupCode: null, setupURI: null, qrSvg: null, pairedControllers: 0, error: null }
const running = { ...base, enabled: true, running: true, setupCode: '316-88-759', setupURI: 'X-HM://0023ABCDA3J5', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }

beforeEach(() => {
  state.status = base
  state.pending = false
  state.setError = null
  for (const f of Object.values(calls)) f.mockReset()
})
afterEach(cleanup)

const toggle = () => screen.getByRole('switch', { name: 'HomeKit' })

describe('Settings → HomeKit', () => {
  it('keeps its anchor but no controls where core has no bridge (the demo) and while loading', () => {
    state.status = { ...base, available: false }
    render(<HomeKitSection />)
    expect(document.getElementById('homekit')).toBeTruthy()
    expect(screen.getByText(/isn't available in this demo/)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()
    state.status = undefined
    render(<HomeKitSection />)
    expect(screen.getByRole('heading', { name: 'Apple Home' })).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('starts off, with no code shown; the switch turns it on', () => {
    render(<HomeKitSection />)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByTestId('homekit-code')).toBeNull()
    expect(screen.queryByText('Reset pairing')).toBeNull()
    fireEvent.click(toggle())
    expect(calls.setEnabled).toHaveBeenCalledWith({ enabled: true })
    expect(calls.invalidate).toHaveBeenCalled()
  })

  it('shows the setup code and its QR while waiting to be paired, and checks for the pairing', () => {
    state.status = running
    render(<HomeKitSection />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('homekit-code').textContent).toBe('316-88-759')
    const qr = screen.getByAltText('HomeKit setup code QR') as HTMLImageElement
    expect(decodeURIComponent(qr.src)).toBe(`data:image/svg+xml;utf8,${running.qrSvg}`)
    expect(screen.getByText(/tap \+ → Add Accessory/)).toBeTruthy()
    expect(screen.getByTestId('homekit-paired').textContent).toBe('no')
    expect(screen.getByText('on')).toBeTruthy()
    expect(state.refetch?.({ state: { data: running } })).toBe(5000)
    expect(state.refetch?.({ state: { data: { ...running, pairedControllers: 1 } } })).toBe(30_000)
    expect(state.refetch?.({ state: { data: base } })).toBe(false)
    expect(state.refetch?.({ state: { data: undefined } })).toBe(false)
  })

  it('says who is paired', () => {
    state.status = { ...running, pairedControllers: 2 }
    render(<HomeKitSection />)
    expect(screen.getByTestId('homekit-paired').textContent).toBe('2 controllers')
    expect(screen.getByText(/Already added to Home/)).toBeTruthy()
    cleanup()
    state.status = { ...running, pairedControllers: 1 }
    render(<HomeKitSection />)
    expect(screen.getByTestId('homekit-paired').textContent).toBe('1 controller')
  })

  it('reset asks first, then rotates the pairing', () => {
    state.status = { ...running, pairedControllers: 1 }
    render(<HomeKitSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset pairing' }))
    expect(calls.reset).not.toHaveBeenCalled()
    expect(screen.getByText(/stay “No Response” until you do/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/No Response/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reset pairing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(calls.reset).toHaveBeenCalledTimes(1)
  })

  it('shows why it isn\'t running, and holds the switch while a change is in flight', () => {
    state.status = { ...base, enabled: true, error: 'listen EADDRINUSE :::51827' }
    render(<HomeKitSection />)
    expect(screen.getByText('listen EADDRINUSE :::51827')).toBeTruthy()
    expect(screen.getByText('not running')).toBeTruthy()
    cleanup()
    state.status = { ...base, enabled: true, transitioning: true }
    render(<HomeKitSection />)
    expect((toggle() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('starting')).toBeTruthy()
    cleanup()
    state.status = base
    state.setError = { message: 'HomeKit: mDNS down' }
    render(<HomeKitSection />)
    expect(screen.getByText('HomeKit: mDNS down')).toBeTruthy()
  })
})
