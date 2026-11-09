// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertsPage, categoryOf, describeAlert, openSummary } from '../AlertsPage'

const { data, calls, invalidate } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { acknowledge: vi.fn(), dismiss: vi.fn(), list: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, ...rest }: { to: string, search?: { pod?: number }, children: unknown }) => <a href={search?.pod ? `${to}?pod=${search.pod}` : to} {...rest}>{children as string}</a>,
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (name: 'acknowledge' | 'dismiss') => ({ useMutation: (o?: { onSuccess?: () => void }) => ({
    mutate: (input: unknown) => {
      calls[name](input)
      o?.onSuccess?.()
    },
  }) })
  return {
    trpc: {
      useUtils: () => ({ alerts: { invalidate }, pump: { invalidate } }),
      alerts: {
        list: { useQuery: (input: { activeOnly: boolean }) => {
          calls.list(input)
          return { data: data.get(input.activeOnly ? 'open' : 'all') }
        } },
        acknowledge: mutation('acknowledge'),
        dismiss: mutation('dismiss'),
      },
      grow: { pods: { useQuery: () => ({ data: data.get('pods') }) } },
    },
  }
})

const row = (id: number, kind: string, detail: string, extra: Record<string, unknown> = {}) => ({ id, kind, active: true, detail, raisedAt: '2026-11-01T08:00:00Z', clearedAt: null, acknowledgedAt: null, dismissedAt: null, ...extra })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  invalidate.mockReset()
  const open = [row(2, 'camera_missing', 'lower camera returned 4 bytes'), row(1, 'reminder_nutrients', 'Add nutrients (every 7 days)')]
  data.set('open', open)
  data.set('all', [...open, row(0, 'water_low', 'tank below 10%', { active: false, clearedAt: '2026-10-30T09:00:00Z', acknowledgedAt: '2026-10-30T09:00:00Z' })])
  data.set('pods', [{ slot: 9, plant: 'Red Russian Kale', status: 'attention', notes: 'yellowing lower leaves' }, { slot: 3, plant: null, status: 'attention', notes: ' ' }, { slot: 1, plant: 'Basil', status: 'growing', notes: '' }])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AlertsPage', () => {
  it('summarises what is open and shows each alert with its category and age', () => {
    render(<AlertsPage />)
    expect(screen.getByText('2 open · 1 hardware, 1 reminder')).toBeTruthy()
    const cam = within(screen.getByTestId('alert-camera_missing'))
    expect(cam.getByText('Lower camera not capturing')).toBeTruthy()
    expect(cam.getByText('hardware')).toBeTruthy()
    expect(cam.getByText('Returned 4 bytes on the last capture. Pods 16–30 have no new photos.')).toBeTruthy()
    expect(cam.getByText(/4 h ago/)).toBeTruthy()
    expect(cam.getByText('Acknowledging re-enables the camera. Fix the cause first.')).toBeTruthy()
    expect(cam.getByText('View camera').getAttribute('href')).toBe('/cameras')
    const chore = within(screen.getByTestId('alert-reminder_nutrients'))
    expect(chore.getByText('reminder')).toBeTruthy()
    expect(chore.queryByText(/re-enables/)).toBeNull()
  })

  it('acknowledges a fault, marks a reminder done and dismisses', () => {
    render(<AlertsPage />)
    fireEvent.click(screen.getByText('Acknowledge'))
    expect(calls.acknowledge).toHaveBeenCalledWith({ id: 2 })
    fireEvent.click(screen.getByText('Done'))
    expect(calls.acknowledge).toHaveBeenLastCalledWith({ id: 1 })
    fireEvent.click(screen.getAllByText('Dismiss')[1] as HTMLElement)
    expect(calls.dismiss).toHaveBeenCalledWith({ id: 1 })
    expect(invalidate).toHaveBeenCalled()
  })

  it('lists pods needing attention from Grow, linking to each', () => {
    render(<AlertsPage />)
    const kale = screen.getByText(/Red Russian Kale · pod 9/).closest('a') as HTMLAnchorElement
    expect(kale.getAttribute('href')).toBe('/grow?pod=9')
    expect(kale.textContent).toContain('yellowing lower leaves')
    expect(screen.getByText(/Pod 3 · pod 3/).closest('a')?.textContent).toContain('needs attention')
    expect(screen.queryByText(/Basil/)).toBeNull()
  })

  it('shows history with when each alert cleared, and no actions', () => {
    render(<AlertsPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(calls.list).toHaveBeenCalledWith({ activeOnly: false })
    const old = within(screen.getByTestId('alert-water_low'))
    expect(old.getByText(/cleared .* · acknowledged/)).toBeTruthy()
    expect(old.queryByText('Acknowledge')).toBeNull()
    expect(screen.queryByText('Plants · from Grow')).toBeNull()
  })

  it('says when there is nothing to see', () => {
    data.set('open', [])
    data.set('pods', [])
    render(<AlertsPage />)
    expect(screen.getByText('Nothing open')).toBeTruthy()
    expect(screen.getByText(/Nothing to see/)).toBeTruthy()
  })
})

describe('alert helpers', () => {
  it('sorts kinds into hardware, reminder and service', () => {
    expect(categoryOf('pump_fault')).toBe('hardware')
    expect(categoryOf('reminder_harvest')).toBe('reminder')
    expect(categoryOf('mirror_failed')).toBe('service')
  })
  it('shows a connection notice as hardware, with a way to the repair', () => {
    expect(categoryOf('camera_link_upper')).toBe('hardware')
    expect(categoryOf('camera_hub_flaky')).toBe('hardware')
    const detail = 'Top camera\'s connection may be failing: 6 of its last 20 photos were damaged. Reseat its cable.'
    expect(describeAlert({ kind: 'camera_link_upper', detail })).toEqual({ title: 'Top camera connection', detail })
    data.set('open', [row(9, 'camera_link_upper', detail)])
    render(<AlertsPage />)
    expect(screen.getByRole('link', { name: 'How to reseat it' }).getAttribute('href')).toContain('/core/maintenance/#reseat-a-camera-cable')
    expect(screen.getByRole('link', { name: 'View camera' }).getAttribute('href')).toBe('/cameras')
  })

  it('shows a setup warning as service, with a way to where it is fixed (ADR-0029)', () => {
    expect(categoryOf('setup_pump_schedule')).toBe('service')
    data.set('open', [row(7, 'setup_pump_schedule', '3 pods planted but no pump schedule is on.'), row(8, 'setup_water_sensor', 'The tank level reads suspect.'), row(6, 'setup_light_schedule', '3 pods planted but no light schedule is on.')])
    render(<AlertsPage />)
    expect(within(screen.getByTestId('alert-setup_pump_schedule')).getByText('No pump schedule')).toBeTruthy()
    expect(within(screen.getByTestId('alert-setup_pump_schedule')).getByRole('link', { name: 'View water' }).getAttribute('href')).toBe('/water')
    expect(within(screen.getByTestId('alert-setup_light_schedule')).getByRole('link', { name: 'View light' }).getAttribute('href')).toBe('/light')
    expect(within(screen.getByTestId('alert-setup_water_sensor')).getByText('Tank sensor')).toBeTruthy()
    expect(within(screen.getByTestId('alert-setup_water_sensor')).getByRole('link', { name: 'View sensors' }).getAttribute('href')).toBe('/sensors')
  })

  it('falls back to the label and raw detail', () => {
    expect(describeAlert({ kind: 'over_temp', detail: 'board at 71°C' })).toEqual({ title: 'Board over temperature', detail: 'board at 71°C' })
    expect(describeAlert({ kind: 'camera_missing', detail: 'no camera' })).toEqual({ title: 'Camera not capturing', detail: 'no camera' })
    expect(describeAlert({ kind: 'mystery', detail: '' })).toEqual({ title: 'mystery', detail: '' })
    expect(describeAlert({ kind: 'camera_missing', detail: 'upper camera returned 0 bytes' }).detail).toContain('Pods 1–15')
  })
  it('counts open alerts by category', () => {
    expect(openSummary([{ kind: 'reminder_a' }, { kind: 'reminder_b' }, { kind: 'mirror_failed' }])).toBe('3 open · 2 reminders, 1 service')
  })
})
