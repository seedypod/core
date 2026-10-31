// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WifiPage } from '../WifiPage'

const { data, calls } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { startSetup: vi.fn(), stopSetup: vi.fn(), connect: vi.fn(), refetch: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: (_i?: unknown, o?: { enabled?: boolean }) => ({
    data: o?.enabled === false ? undefined : data.get(name),
    isLoading: data.get(`${name}Loading`) === true,
    error: data.get(`${name}Error`) ?? null,
    refetch: calls.refetch,
  }) })
  const mutation = (name: 'startSetup' | 'stopSetup' | 'connect') => ({ useMutation: () => ({
    isPending: false,
    data: data.get(`${name}Result`),
    error: data.get(`${name}Error`) ?? null,
    mutate: (input?: unknown) => calls[name](input),
  }) })
  return {
    trpc: {
      useUtils: () => ({ network: { invalidate: vi.fn() } }),
      network: { status: query('status'), scan: query('scan'), startSetup: mutation('startSetup'), stopSetup: mutation('stopSetup'), connect: mutation('connect') },
    },
  }
})

const client = { available: true, mode: 'client', ssid: 'Home', ip: '192.168.1.40', setup: null, lastError: null }
const networks = [{ ssid: 'Home', signal: 78, secure: true, inUse: true }, { ssid: 'Garden Shed', signal: 31, secure: false, inUse: false }]

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  data.set('status', client)
  data.set('scan', networks)
})
afterEach(cleanup)

describe('WifiPage', () => {
  it('shows the current network and opens the setup hotspot', () => {
    render(<WifiPage />)
    expect(screen.getAllByText('connected').length).toBeGreaterThan(0)
    expect(screen.getByText('Home', { selector: 'span.flex-1' })).toBeTruthy()
    expect(screen.getByText('192.168.1.40')).toBeTruthy()
    expect(screen.getByLabelText('secured')).toBeTruthy()
    fireEvent.click(screen.getByText('Open setup hotspot'))
    expect(calls.startSetup).toHaveBeenCalledWith({ minutes: 15 })
    fireEvent.click(screen.getByText('Rescan'))
    expect(calls.refetch).toHaveBeenCalled()
  })

  it('joins a secured network once the password is long enough', () => {
    render(<WifiPage />)
    fireEvent.click(screen.getByText('Home', { selector: 'span.flex-1' }))
    const join = screen.getByText('Join') as HTMLButtonElement
    expect(join.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } })
    fireEvent.click(join)
    expect(calls.connect).toHaveBeenCalledWith({ ssid: 'Home', password: 'correct horse' })
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Join Home')).toBeNull()
  })

  it('joins an open network without a password and shows the reply', () => {
    data.set('connectResult', { ok: true, detail: 'saved Garden Shed; switching in a moment.' })
    render(<WifiPage />)
    fireEvent.click(screen.getByText('Garden Shed'))
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.getByText('saved Garden Shed; switching in a moment.')).toBeTruthy()
    expect((screen.getByText('Join') as HTMLButtonElement).disabled).toBe(true)
  })

  it('guides the owner while the hotspot is up and after a failed join', () => {
    data.set('status', { ...client, mode: 'setup', ssid: 'seedypod-setup-ab12', ip: '10.42.0.1', setup: { ssid: 'seedypod-setup-ab12', url: 'http://10.42.0.1:3000/wifi', until: '2026-10-31T12:15:00Z' }, lastError: 'couldn\'t join Home: Secrets were required' })
    data.set('connectResult', { ok: false, detail: 'a WPA password is 8–63 characters' })
    render(<WifiPage />)
    expect(screen.getByText('Setup hotspot is on')).toBeTruthy()
    expect(screen.getByText('couldn\'t join Home: Secrets were required')).toBeTruthy()
    expect(screen.queryByText('Open setup hotspot')).toBeNull()
    fireEvent.click(screen.getByText('Close the hotspot'))
    expect(calls.stopSetup).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Home', { selector: 'span.flex-1' }))
    expect(screen.getByText('a WPA password is 8–63 characters')).toBeTruthy()
  })

  it('handles scanning, empty and failed scans, and hosts without NetworkManager', () => {
    data.set('scanLoading', true)
    data.set('scan', [])
    data.set('startSetupError', new Error('nmcli: permission denied'))
    render(<WifiPage />)
    expect(screen.getByText('Scanning…')).toBeTruthy()
    expect(screen.getByText('No networks found.')).toBeTruthy()
    expect(screen.getByText('nmcli: permission denied')).toBeTruthy()
    cleanup()
    data.set('scanError', new Error('Wi-Fi radio is off'))
    render(<WifiPage />)
    expect(screen.getByText('Wi-Fi radio is off')).toBeTruthy()
    cleanup()
    data.set('status', { ...client, available: false })
    render(<WifiPage />)
    expect(screen.getByText(/managed by the host/)).toBeTruthy()
  })
})
