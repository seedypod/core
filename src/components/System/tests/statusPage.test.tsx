// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkSummary, worstState, type SystemCheck } from '../checkState'
import { alertSource, alertTitle, StatusPage } from '../StatusPage'

const { data, sub, mutate } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  sub: { onData: null as null | ((e: unknown) => void) },
  mutate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: unknown, to: string }) => <a href={to} {...rest}>{children as string}</a>,
}))
vi.mock('@/src/utils/trpc', () => {
  const key = (path: string, input?: { sensor?: string }) => (input?.sensor ? `${path}:${input.sensor}` : path)
  const calls = (path: string): unknown => new Proxy(() => undefined, {
    get: (_, k: string) => calls(path ? `${path}.${k}` : k),
    apply: () => ({ path }),
  })
  const node = (path: string): unknown => new Proxy({}, {
    get: (_, k: string) => {
      if (k === 'useQuery') return (input?: { sensor?: string }) => ({ data: data.get(key(path, input)) })
      if (k === 'useSubscription') return (_i: unknown, opts: { onData: (e: unknown) => void }) => (sub.onData = opts.onData)
      if (k === 'useMutation') return (opts?: { onSuccess?: () => void }) => ({ isPending: false, mutate: (i: unknown) => {
        mutate(path, i)
        opts?.onSuccess?.()
      } })
      if (k === 'useUtils') return () => new Proxy({}, { get: () => ({ invalidate: vi.fn() }) })
      if (k === 'useQueries') return (fn: (t: unknown) => Array<{ path: string }>) => fn(calls('')).map(c => ({ data: data.get(c.path) }))
      return node(path ? `${path}.${k}` : k)
    },
  })
  return { trpc: node(''), apiBase: () => '' }
})

// 18:00 local on an ordinary day (no DST change), so minutes of the day are plain.
const NOW = new Date(2026, 9, 20, 18, 0)
const at = (h: number, m = 0) => new Date(2026, 9, 20, h, m).toISOString()
const check = (id: string, state: SystemCheck['state'], label = id, detail = ''): SystemCheck => ({ id, label, state, detail, since: null })

const sensor = (ts: string) => ({ kind: 'hal', event: { type: 'sensor', id: 'air_temp', reading: { ts, value: 22, unit: '°C', quality: 'good' } } })
const main = () => screen.getByRole('main')
const page = () => render(<main><StatusPage /></main>)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  data.set('settings.get', { unitName: 'Kitchen Gardyn' })
})

afterEach(() => {
  cleanup()
  data.clear()
  sub.onData = null
  mutate.mockClear()
  vi.useRealTimers()
})

describe('StatusPage header and live pill', () => {
  it('shows the breadcrumb and title, and the live pill before any reading', () => {
    data.set('system.info', { coreVersion: 'dev', halOnline: true, system: { halVersion: '0.9.3', contract: 1, caps: { sensors: ['air_temp', 'humidity', 'ph'] } } })
    page()
    expect(within(main()).getByText('System /')).toBeTruthy()
    expect(within(main()).getByRole('heading', { level: 1, name: 'Status' })).toBeTruthy()
    const pill = within(main()).getByTestId('live-pill')
    expect(within(pill).getByText('LIVE')).toBeTruthy()
    expect(within(pill).getByText('— Hz')).toBeTruthy()
    expect(within(pill).getByText('3 sensors')).toBeTruthy()
    expect(within(pill).getByText('reading age —')).toBeTruthy()
  })

  it('counts ticks per second and the newest reading age, and stops applying events while paused', async () => {
    data.set('system.info', { coreVersion: 'dev', halOnline: true, system: { halVersion: '0.9.3', contract: 1, caps: { sensors: ['air_temp'] } } })
    page()
    const pill = within(main()).getByTestId('live-pill')
    expect(within(pill).getByText('1 sensor')).toBeTruthy()
    const t0 = NOW.getTime()
    act(() => {
      sub.onData?.({ kind: 'mutation', path: 'settings' })
      sub.onData?.(sensor(new Date(t0 - 400).toISOString()))
    })
    vi.setSystemTime(t0 + 2000)
    act(() => {
      sub.onData?.(sensor(new Date(t0 + 1600).toISOString()))
      // Readings in the same burst count as one tick.
      sub.onData?.(sensor(new Date(t0 + 1600).toISOString()))
    })
    await waitFor(() => expect(within(pill).getByText('reading age 0.4s')).toBeTruthy())
    expect(within(pill).getByText('0.5 Hz')).toBeTruthy()
    fireEvent.click(within(pill).getByRole('button', { name: 'Pause' }))
    expect(within(pill).getByText('PAUSED')).toBeTruthy()
    act(() => sub.onData?.(sensor(new Date(t0 + 2000).toISOString())))
    vi.setSystemTime(t0 + 2100)
    await waitFor(() => expect(within(pill).getByText('reading age 0.5s')).toBeTruthy())
    fireEvent.click(within(pill).getByRole('button', { name: 'Resume' }))
    act(() => sub.onData?.(sensor(new Date(t0 + 2100).toISOString())))
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(t0 + 2100 + i * 400)
      act(() => sub.onData?.(sensor(new Date(t0 + 2100 + i * 400).toISOString())))
    }
    vi.setSystemTime(t0 + 15_000)
    await waitFor(() => expect(within(pill).getByText('reading age 12s')).toBeTruthy())
    expect(within(pill).getByText('— Hz')).toBeTruthy()
  })
})

describe('health strip', () => {
  const vitals = () => {
    data.set('system.checks', { checks: [check('hal', 'ok'), check('cameras', 'down', 'Cameras', 'lower camera returned 0 bytes'), check('homekit', 'idle')] })
    data.set('system.info', { coreVersion: 'main@1a2b3c4d5e', halOnline: true, system: { halVersion: '0.9.3', contract: 1, caps: { sensors: [] } } })
    data.set('network.status', { available: true, mode: 'client', ssid: 'Home' })
    data.set('network.scan', [{ ssid: 'Other', signal: 90, inUse: false }, { ssid: 'Home', signal: 72, inUse: true }])
    data.set('system.bridge', { state: 'connected', broker: 'ha.local', since: null, error: null })
    data.set('storage.flash', { usedBytes: 41, freeBytes: 59, uptimeS: 4 * 86400 + 6 * 3600 })
  }

  it('shows the hub rate over recent boots, with the log to download, once there is one', () => {
    page()
    expect(screen.queryByText('USB hub')).toBeNull()
    cleanup()
    data.set('system.bootLog', { boots: 12, hub: { up: 3, of: 12 } })
    page()
    expect(screen.getByText('up on 3 of the last 12 boots')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Boot log' }).getAttribute('href')).toBe('/api/system/boot-log')
    cleanup()
    data.set('system.bootLog', { boots: 2, hub: null })
    page()
    expect(screen.getByText('2 boots logged')).toBeTruthy()
  })

  it('rings the checks passing, heads with the issue count and the worst check, then the vitals', () => {
    vitals()
    page()
    const strip = within(main()).getByRole('region', { name: 'Health' })
    expect(within(strip).getByLabelText('2 of 3 checks passing').textContent).toBe('2/3')
    expect(within(strip).getByText('Kitchen Gardyn has one issue')).toBeTruthy()
    expect(within(strip).getByText('Cameras: lower camera returned 0 bytes')).toBeTruthy()
    expect(within(strip).getByText('1a2b3c4')).toBeTruthy()
    expect(within(strip).getByText('main')).toBeTruthy()
    expect(within(strip).getByText('hald 0.9.3 · v1')).toBeTruthy()
    expect(within(strip).getByText('Home 72%')).toBeTruthy()
    expect(within(strip).getByLabelText('Signal 72%').querySelectorAll('.bg-pod-ok')).toHaveLength(3)
    expect(within(strip).getByText('bridged')).toBeTruthy()
    expect(within(strip).getByRole('meter', { name: 'SD card used' }).getAttribute('aria-valuenow')).toBe('41')
    expect(within(strip).getByText('41%')).toBeTruthy()
    expect(within(strip).getByText('4d 6h')).toBeTruthy()
  })

  it('reads healthy, offline hardware, unmanaged Wi-Fi, HA off or in error, and hides uptime off a Pi', () => {
    data.set('system.checks', { checks: [check('hal', 'ok'), check('homekit', 'idle')] })
    data.set('system.info', { coreVersion: 'dev', halOnline: false, system: null })
    data.set('network.status', { available: false, mode: 'offline', ssid: null })
    data.set('system.bridge', { state: 'off', broker: null, since: null, error: null })
    data.set('storage.flash', { usedBytes: null, freeBytes: null, uptimeS: null })
    const { unmount } = page()
    let strip = within(main()).getByRole('region', { name: 'Health' })
    expect(within(strip).getByText('Kitchen Gardyn is healthy')).toBeTruthy()
    expect(within(strip).getByText('All 2 checks passing')).toBeTruthy()
    expect(within(strip).getByText('local')).toBeTruthy()
    expect(within(strip).getByText('offline')).toBeTruthy()
    expect(within(strip).getByText('not managed')).toBeTruthy()
    expect(within(strip).getByText('off')).toBeTruthy()
    expect(within(strip).queryByText('Uptime')).toBeNull()
    unmount()
    data.set('network.status', { available: true, mode: 'setup', ssid: 'seedypod-setup' })
    data.set('system.bridge', { state: 'disconnected', broker: 'ha.local', since: null, error: 'ECONNREFUSED' })
    page()
    strip = within(main()).getByRole('region', { name: 'Health' })
    expect(within(strip).getByText('setup')).toBeTruthy()
    expect(within(strip).getByText('error')).toBeTruthy()
  })

  it('shows dashes before anything loads', () => {
    data.delete('settings.get')
    page()
    const strip = within(main()).getByRole('region', { name: 'Health' })
    expect(within(strip).getByText('seedypod is healthy')).toBeTruthy()
    expect(within(strip).getAllByText('—').length).toBeGreaterThanOrEqual(5)
  })

  it('shows the SSID alone when the scan has no signal for it', () => {
    vitals()
    data.set('network.scan', [])
    page()
    expect(within(within(main()).getByRole('region', { name: 'Health' })).getByText('Home')).toBeTruthy()
  })
})

describe('alert card', () => {
  it('is hidden with nothing active', () => {
    data.set('alerts.list', [{ id: 1, kind: 'camera_missing', active: false, detail: '', raisedAt: at(9) }])
    page()
    expect(within(main()).queryByRole('region', { name: 'Alerts' })).toBeNull()
  })

  it('lists each active alert with source, kind and age, says what it means, and acknowledges', () => {
    data.set('alerts.list', [{ id: 7, kind: 'camera_missing', active: true, detail: 'lower camera returned 0 bytes', raisedAt: at(15, 55) }])
    page()
    const card = within(main()).getByRole('region', { name: 'Alerts' })
    expect(within(card).getByRole('heading', { name: 'Camera alert' })).toBeTruthy()
    expect(within(card).getByText('lower · camera_missing · 2h 5m ago')).toBeTruthy()
    expect(within(card).getByText(/Pods 16–30 have no new photos\. It stays until you clear it/)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Clear fault' }))
    expect(mutate).toHaveBeenCalledWith('alerts.acknowledge', { id: 7 })
  })

  it('titles several kinds by count, and leaves the latch line off reminders', () => {
    data.set('alerts.list', [
      { id: 1, kind: 'reminder_nutrients', active: true, detail: 'Add nutrients', raisedAt: at(17) },
      { id: 2, kind: 'mirror_failed', active: true, detail: 'copy failed', raisedAt: at(16) },
    ])
    page()
    const card = within(main()).getByRole('region', { name: 'Alerts' })
    expect(within(card).getByRole('heading', { name: '2 alerts' })).toBeTruthy()
    expect(within(card).getByText('Add nutrients')).toBeTruthy()
    expect(within(card).queryByText(/stays latched/)).toBeNull()
  })

  it('leaves the stay-until-cleared line off a low-water alert, which clears by itself', () => {
    data.set('alerts.list', [{ id: 3, kind: 'water_low', active: true, detail: 'water distance 17.0 cm ≥ 16.0 cm', raisedAt: at(17) }])
    page()
    const card = within(main()).getByRole('region', { name: 'Alerts' })
    expect(within(card).queryByText(/It stays until you clear it/)).toBeNull()
    expect(within(card).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('names titles and sources from the kind', () => {
    expect(alertTitle(['pump_fault'])).toBe('Pump alert')
    expect(alertTitle(['camera_link_upper'])).toBe('Camera alert')
    expect(alertTitle(['camera_hub_flaky'])).toBe('Camera alert')
    expect(alertSource('camera_link_lower', 'Bottom camera\'s connection may be failing')).toBe('lower')
    expect(alertSource('camera_hub_flaky', 'The cameras\' USB hub')).toBe('usb hub')
    expect(alertTitle(['reminder_harvest'])).toBe('Reminder')
    expect(alertTitle([])).toBe(' alert')
    expect(alertSource('camera_missing', 'upper camera returned 0 bytes')).toBe('upper')
    expect(alertSource('camera_missing', 'odd')).toBe('core')
    expect(alertSource('light_fault', '')).toBe('light')
    expect(alertSource('water_low', '')).toBe('hald')
    expect(alertSource('reminder_harvest', '')).toBe('grow')
  })
})

describe('today timeline', () => {
  const day = () => {
    data.set('schedules.list', [
      { id: 'curve', kind: 'light', name: 'Day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 80 }, { minute: 1260, level: 30 }, { minute: 1320, level: 0 }] } },
      { id: 'p1', kind: 'pump', name: 'Morning', enabled: true, days: 127, spec: { minute: 480, durationS: 30 } },
      { id: 'p2', kind: 'pump', name: 'Evening', enabled: true, days: 127, spec: { minute: 1200, durationS: 30 } },
      { id: 'p3', kind: 'pump', name: 'Off', enabled: false, days: 127, spec: { minute: 1230, durationS: 30 } },
    ])
    data.set('schedules.previewCurve', Array.from({ length: 96 }, (_, i) => ({ minute: i * 15, level: i * 15 >= 360 && i * 15 < 1260 ? 80 : 0 })))
    data.set('light.get', { on: true, level: 49, since: at(6) })
    data.set('schedules.recentRuns', [{ scheduleId: 'p1', key: 'k', firedAt: at(8), result: 'ok' }, { scheduleId: 'p1', key: 'y', firedAt: new Date(2026, 9, 19, 8).toISOString(), result: 'ok' }])
    data.set('telemetry.history:water_level_pct', [{ ts: at(1), value: 88 }, { ts: at(12), value: 80 }])
    data.set('telemetry.history:air_temp', [{ ts: at(1), value: 20.5 }, { ts: at(14), value: 26.5 }, { ts: at(17), value: 25.5 }])
    data.set('backup.status', { recent: [{ ts: at(3), ok: true }, { ts: at(4), ok: false }] })
    data.set('automations.list', [{ id: 3, name: 'Hot afternoon dimmer' }])
    data.set('automations.runs', [
      { id: 1, automationId: 3, firedAt: at(11, 20), outcome: 'fired' },
      { id: 2, automationId: 3, firedAt: at(11, 21), outcome: 'fired' },
      { id: 3, automationId: 4, firedAt: at(12), outcome: 'dry_run' },
      { id: 4, automationId: 9, firedAt: at(13), outcome: 'fired' },
    ])
    data.set('alerts.list', [
      { id: 5, kind: 'camera_missing', active: false, detail: 'lower camera returned 0 bytes', raisedAt: at(16, 24) },
      { id: 6, kind: 'reminder_nutrients', active: false, detail: '', raisedAt: at(16, 30) },
    ])
  }

  it('heads with the next job and the job count, and draws light, water and air with a now line each', () => {
    day()
    page()
    const today = within(main()).getByRole('region', { name: 'Today' })
    expect(within(today).getByText('next: pump at 20:00 · in 2h 0m')).toBeTruthy()
    expect(within(today).getByRole('link', { name: /3 jobs · Schedule/ }).getAttribute('href')).toBe('/light')
    expect(within(today).getAllByTestId('now-line')).toHaveLength(4)
    expect(within(today).getAllByTestId('now-line')[0]?.style.left).toBe('75%')
    const light = within(today).getByRole('group', { name: 'Light' })
    expect(within(light).getByTestId('light-past').getAttribute('points')?.endsWith('750,51')).toBe(true)
    expect(within(light).getByTestId('light-future').getAttribute('points')?.startsWith('750,20')).toBe(true)
    const water = within(today).getByRole('group', { name: 'Water' })
    expect(within(water).getByTestId('pump-past').getAttribute('d')).toBe('M333.3 100 V62')
    expect(within(water).getByTestId('pump-future').getAttribute('d')).toBe('M833.3 100 V62')
    expect(within(water).getByTestId('tank-line').getAttribute('points')).toBe('41.7,30 500,70')
    expect(within(today).getByRole('group', { name: 'Air' }).textContent).toContain('19–28°C')
  })

  it('marks backups, the first of each Autopilot burst and raised alerts on the events lane', () => {
    day()
    page()
    const events = within(within(main()).getByRole('region', { name: 'Today' })).getByRole('group', { name: 'Events' })
    expect(within(events).getByText('Backup')).toBeTruthy()
    expect(within(events).getAllByText('Hot afternoon dim…')).toHaveLength(1)
    expect(within(events).getByText('Autopilot')).toBeTruthy()
    expect(within(events).getByText('Lower camera not…')).toBeTruthy()
    expect(within(events).getByText('Add nutrients').closest('[data-row]')?.getAttribute('data-row')).toBe('1')
    expect(within(events).getByText('Backup').previousElementSibling?.className).toContain('bg-fg-3')
  })

  it('says when nothing else is scheduled, and draws nothing without data', () => {
    page()
    const today = within(main()).getByRole('region', { name: 'Today' })
    expect(within(today).getByText('nothing else scheduled today')).toBeTruthy()
    expect(within(today).getByRole('link', { name: /0 jobs/ })).toBeTruthy()
    expect(within(today).getByTestId('light-past').getAttribute('points')).toBe('')
  })
})

describe('cards', () => {
  it('sums up light, water and climate, each linking to its page', () => {
    data.set('schedules.list', [
      { id: 'curve', kind: 'light', name: 'Day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 80 }, { minute: 1260, level: 30 }] } },
      { id: 'p1', kind: 'pump', name: 'A', enabled: true, days: 127, spec: { minute: 480, durationS: 30 } },
      { id: 'p2', kind: 'pump', name: 'B', enabled: true, days: 127, spec: { minute: 1200, durationS: 60 } },
    ])
    data.set('schedules.previewCurve', Array.from({ length: 96 }, (_, i) => ({ minute: i * 15, level: 40 })))
    data.set('light.get', { on: true, level: 49, since: at(6) })
    data.set('light.owner', { source: 'schedule' })
    data.set('telemetry.lightHours', { hours: 1842.4, ratedHours: 25000, pctUsed: 7.4 })
    data.set('pump.get', { on: false })
    data.set('sensors.latest', { water_level_pct: { value: 71, unit: '%' }, pump_v: { value: 12.3, unit: 'V' }, water_distance: { value: 9.4, unit: 'cm' }, air_temp: { value: 25.5, unit: '°C' }, humidity: { value: 55, unit: '%' }, pcb_temp: { value: 34.5, unit: '°C' } })
    data.set('schedules.recentRuns', [{ scheduleId: 'p1', key: 'k', firedAt: at(17, 14), result: 'ok' }])
    data.set('telemetry.history:water_level_pct', [{ ts: at(7), value: 80 }, { ts: at(17), value: 71 }])
    data.set('telemetry.history:air_temp', [{ ts: new Date(2026, 9, 19, 23).toISOString(), value: 29 }, { ts: at(14), value: 26.5 }, { ts: at(17), value: 25.5 }])
    data.set('devices.list', { sensors: [{ kind: 'dht20', status: 'ready', ids: ['air_temp', 'humidity'] }, { kind: 'pct2075', status: 'ready', ids: ['pcb_temp'] }, { kind: 'dyp_a01', status: 'ready', ids: ['water_level_pct'] }] })
    page()
    const light = within(main()).getByRole('link', { name: 'Light' })
    expect(light.getAttribute('href')).toBe('/light')
    for (const t of ['SCHEDULE', '49%', '06:00', '21:00', '1,842', '7.4% of 25,000 rated hours']) expect(within(light).getByText(t)).toBeTruthy()
    const water = within(main()).getByRole('link', { name: 'Water' })
    for (const t of ['IDLE', '71%', '46m ago', '12.3 V', '20:00', '30 s+ × 2 today · 9.4 cm to water']) expect(within(water).getByText(t)).toBeTruthy()
    const climate = within(main()).getByRole('link', { name: 'Climate' })
    expect(climate.getAttribute('href')).toBe('/sensors')
    for (const t of ['NORMAL', '25.5°', '55%', '34.5°C', '26.5°', 'DHT20 · PCT2075']) expect(within(climate).getByText(t)).toBeTruthy()
    expect(climate.querySelector('polyline')?.getAttribute('points')).not.toBe('')
  })

  it('reads off, manual, running and hot, with dashes for what is missing', () => {
    data.set('light.get', { on: false, level: 0, since: at(6) })
    data.set('pump.get', { on: true })
    data.set('alerts.list', [{ id: 1, kind: 'over_temp', active: true, detail: 'board 71°C', raisedAt: at(17) }])
    const { unmount } = page()
    const light = within(main()).getByRole('link', { name: 'Light' })
    expect(within(light).getByText('OFF')).toBeTruthy()
    expect(within(light).getAllByText('off')).toHaveLength(2)
    expect(within(main()).getByRole('link', { name: 'Water' }).textContent).toContain('RUNNING')
    expect(within(main()).getByRole('link', { name: 'Water' }).textContent).toContain('no pump cycles today')
    const climate = within(main()).getByRole('link', { name: 'Climate' })
    expect(within(climate).getByText('HOT')).toBeTruthy()
    expect(within(climate).getByText('air, humidity and board sensors')).toBeTruthy()
    unmount()
    data.set('light.get', { on: true, level: 60, since: at(6) })
    data.set('light.owner', { source: 'manual' })
    page()
    expect(within(within(main()).getByRole('link', { name: 'Light' })).getByText('MANUAL')).toBeTruthy()
  })

  it('reads ON when the light is lit with no owner', () => {
    data.set('light.get', { on: true, level: 60, since: at(6) })
    page()
    expect(within(within(main()).getByRole('link', { name: 'Light' })).getByText('ON')).toBeTruthy()
  })
})

describe('check helpers', () => {
  it('ranks the worst state, idle passing', () => {
    expect(worstState([])).toBeNull()
    expect(worstState([{ state: 'ok' }, { state: 'idle' }])).toBe('idle')
    expect(worstState([{ state: 'ok' }, { state: 'down' }, { state: 'stalled' }])).toBe('down')
    expect(checkSummary([])).toBeNull()
    expect(checkSummary([{ state: 'ok' }, { state: 'idle' }, { state: 'down' }])).toEqual({ passing: 2, total: 3 })
  })
})
