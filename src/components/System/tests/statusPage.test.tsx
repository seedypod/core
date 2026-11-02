// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSummary, worstState, type SystemCheck } from '../checkState'
import { problemLine, size, StatusPage } from '../StatusPage'

const { data, errors } = vi.hoisted(() => ({ data: new Map<string, unknown>(), errors: new Set<string>() }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: unknown, to: string }) => <a href={to} {...rest}>{children as string}</a>,
}))
vi.mock('@/src/utils/trpc', () => {
  const proc = (p: string) => ({ useQuery: () => ({ data: data.get(p), isError: errors.has(p) }) })
  const router = (prefix: string): unknown => new Proxy({}, { get: (_, k: string) => (k === 'useQuery' ? proc(prefix).useQuery : router(prefix ? `${prefix}.${k}` : k)) })
  return { trpc: router('') }
})

const check = (id: string, label: string, state: SystemCheck['state'], detail = '', since: string | null = null): SystemCheck => ({ id, label, state, detail, since })
const CHECKS: SystemCheck[] = [
  check('hal', 'Hardware daemon', 'ok', 'gardyn 3.0 · hald 0.4.1'),
  check('sensors', 'Sensors', 'stalled', '7 of 8 reporting · humidity stale', new Date(Date.now() - 20 * 60_000).toISOString()),
  check('pump', 'Pump', 'down', 'dry run'),
  check('autopilot', 'Autopilot', 'idle', 'Off'),
  check('bridge', 'Home Assistant', 'ok', 'broker.local'),
  check('future', 'Something new', 'ok', 'from a newer core'),
]
const FLASH = { usedBytes: 8e9, freeBytes: 24e9, bytesPerDay: 120e6, device: 'mmcblk0' }

const page = () => {
  render(<main><StatusPage /></main>)
  return screen.getByRole('main')
}

afterEach(() => {
  cleanup()
  data.clear()
  errors.clear()
})

describe('StatusPage', () => {
  it('groups the checks, with state, detail and how long, linking where there is somewhere to go', () => {
    data.set('system.checks', { checks: CHECKS })
    const main = page()
    const hardware = within(main).getByRole('region', { name: 'Hardware' })
    expect(within(hardware).getAllByRole('listitem').map(li => li.dataset.testid)).toEqual(['check-hal', 'check-sensors', 'check-pump'])
    const sensors = within(main).getByTestId('check-sensors')
    expect(within(sensors).getByText('Stalled')).toBeTruthy()
    expect(within(sensors).getByText('7 of 8 reporting · humidity stale')).toBeTruthy()
    expect(within(sensors).getByText('since 20 min ago')).toBeTruthy()
    expect(within(sensors).getByRole('link').getAttribute('href')).toBe('/sensors')
    expect(within(main).getByTestId('check-pump').querySelector('a')?.getAttribute('href')).toBe('/water')
    expect(within(main).getByTestId('check-hal').querySelector('a')).toBeNull()
    // A check this page doesn't know yet still shows, under the last group.
    expect(within(within(main).getByRole('region', { name: 'Integrations' })).getByText('Something new')).toBeTruthy()
  })

  it('leads with the worst state and the count passing', () => {
    data.set('system.checks', { checks: CHECKS })
    const summary = within(page()).getByTestId('status-summary')
    expect(within(summary).getByText('Something is down')).toBeTruthy()
    expect(within(summary).getByText('1 down · 1 stalled')).toBeTruthy()
    expect(within(summary).getByText('4/6')).toBeTruthy()
  })

  it('names core, its host and hald under the title', () => {
    data.set('system.info', { coreVersion: '1.4.0', coreHost: { hostname: 'gardyn', arch: 'arm64' }, system: { halVersion: '0.4.1' } })
    expect(within(page()).getByText('core 1.4.0 · gardyn (arm64) · hald 0.4.1')).toBeTruthy()
  })

  it('says so when core does not answer, and shows no summary before there are checks', () => {
    errors.add('system.checks')
    const main = page()
    expect(within(main).getByText(/didn.t answer the status check/)).toBeTruthy()
    expect(within(main).queryByTestId('status-summary')).toBeNull()
  })

  it('shows disk used and free with a meter, and writes per day', () => {
    data.set('storage.flash', FLASH)
    const main = page()
    expect(within(main).getByRole('meter', { name: 'Disk used' }).getAttribute('aria-valuenow')).toBe('25')
    expect(within(main).getByText('8.0 GB')).toBeTruthy()
    expect(within(main).getByText('24 GB')).toBeTruthy()
    expect(within(main).getByText('120 MB/day')).toBeTruthy()
    expect(within(main).getByText('mmcblk0')).toBeTruthy()
  })

  it('says when disk space is not measured, and dashes a missing rate and card', () => {
    data.set('storage.flash', { ...FLASH, usedBytes: null, freeBytes: null })
    const { unmount } = render(<StatusPage />)
    expect(screen.getByText('Not measured on this machine.')).toBeTruthy()
    unmount()
    data.set('storage.flash', { usedBytes: 0, freeBytes: 0, bytesPerDay: null, device: null })
    const main = page()
    expect(within(main).getByRole('meter', { name: 'Disk used' }).getAttribute('aria-valuenow')).toBe('0')
    expect(within(main).getAllByText('—')).toHaveLength(2)
  })

  it('shows the Home Assistant bridge off, connected, or down with the reason', () => {
    data.set('system.bridge', { state: 'off', broker: null, since: null, error: null })
    const { unmount } = render(<StatusPage />)
    expect(screen.getByText(/No broker set/)).toBeTruthy()
    unmount()
    data.set('system.bridge', { state: 'connected', broker: '192.168.1.5:1883', since: new Date().toISOString(), error: 'old' })
    const r = render(<StatusPage />)
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('192.168.1.5:1883')).toBeTruthy()
    expect(screen.getByText('just now')).toBeTruthy()
    expect(screen.queryByText('old')).toBeNull()
    r.unmount()
    data.set('system.bridge', { state: 'disconnected', broker: null, since: null, error: 'ECONNREFUSED' })
    render(<StatusPage />)
    expect(screen.getByText('Disconnected')).toBeTruthy()
    expect(screen.getByText('ECONNREFUSED')).toBeTruthy()
  })
})

describe('check helpers', () => {
  it('ranks the worst state, idle passing', () => {
    expect(worstState([])).toBeNull()
    expect(worstState([{ state: 'ok' }, { state: 'idle' }])).toBe('idle')
    expect(worstState([{ state: 'stalled' }, { state: 'ok' }])).toBe('stalled')
    expect(worstState([{ state: 'ok' }, { state: 'down' }, { state: 'stalled' }])).toBe('down')
    expect(checkSummary([])).toBeNull()
    expect(checkSummary([{ state: 'ok' }, { state: 'idle' }, { state: 'down' }])).toEqual({ passing: 2, total: 3 })
  })

  it('words the problem line and sizes', () => {
    expect(problemLine([])).toBe('')
    expect(problemLine([{ state: 'ok' }, { state: 'idle' }])).toBe('2 of 2 checks passing')
    expect(problemLine([{ state: 'stalled' }])).toBe('1 stalled')
    expect(size(512_000)).toBe('512 kB')
    expect(size(3.2e6)).toBe('3.2 MB')
    expect(size(64e6)).toBe('64 MB')
    expect(size(2e12)).toBe('2.0 TB')
  })
})
