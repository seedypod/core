// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../SettingsPage'

const { data, calls } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { update: vi.fn(), test: vi.fn(), sync: vi.fn(), run: vi.fn(), undo: vi.fn(), browse: vi.fn(), fromBucket: vi.fn() },
}))

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children, className }: { to: string, children: unknown, className?: string }) => <a href={to} className={className}>{children as string}</a> }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name), refetch: vi.fn() }) })
  const mutation = (name: 'update' | 'test' | 'sync' | 'run' | 'undo' | 'browse' | 'fromBucket') => ({ useMutation: () => ({
    isPending: false,
    data: data.get(`${name}Result`),
    error: data.get(`${name}Error`) ?? null,
    mutate: (input?: unknown) => calls[name](input),
  }) })
  return {
    apiBase: () => '',
    trpc: {
      useUtils: () => ({ settings: { invalidate: vi.fn() } }),
      settings: { get: query('settings'), update: mutation('update') },
      system: { info: query('info') },
      backup: { status: query('backup'), runNow: mutation('run'), restoreInfo: query('restoreInfo'), undo: mutation('undo'), list: query('bucketList'), browse: mutation('browse'), restoreFromBucket: mutation('fromBucket') },
      storage: { flash: query('flash'), mirror: query('mirror'), testMirror: mutation('test'), syncMirror: mutation('sync') },
      sensors: { latest: query('sensors') },
      grow: { current: query('grow') },
      homekit: { status: query('homekit'), setEnabled: mutation('update'), resetPairing: mutation('update') },
      update: { status: query('updateInfo'), check: mutation('update'), setChannel: mutation('update'), start: mutation('update') },
    },
  }
})

const settings = {
  unitName: 'Gardyn', timezone: 'UTC', temperatureUnit: 'C', waterFullCm: 5, waterEmptyCm: 20, tankCapacityL: 19,
  thinningReminderDays: 14, rootCheckReminderDays: 21, harvestReminderDays: 35, nutrientReminderDays: 7,
  mqttUrl: null, mqttUsername: null, mqttTlsEnabled: false, mqttTlsInsecure: false, captureIntervalMin: 60,
  primaryAnalyzer: 'green-threshold', analysisArtifacts: false, mirrorEndpoint: null, mirrorBucket: null, mirrorRegion: 'auto', mirrorPrefix: '', mirrorAccessKeyId: null,
  updatedAt: '2026-10-31T00:00:00Z', hasApiKey: false, hasMqttPassword: false, hasAnalysisIngestToken: false, hasMirrorSecret: false,
}
const mirror = { available: true, enabled: true, pending: 1, uploaded: 40, failed: 0, lastError: null, lastUploadAt: null }

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  data.set('settings', settings)
  data.set('mirror', mirror)
})
afterEach(cleanup)

const field = (label: string) => screen.getByText(label).closest('div')?.parentElement?.querySelector('input') as HTMLInputElement

describe('Settings: storage', () => {
  it('links the SD card card to the Database view without scanning from Settings', () => {
    render(<SettingsPage />)
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/database')
  })

  it('shows the since-boot write rate, the card and its yearly full-card writes', () => {
    data.set('flash', { available: true, device: 'mmcblk0', cardBytes: 32e9, sinceBootBytes: 1.5e9, uptimeS: 2 * 3600, bytesPerDay: 0.8e9, basis: 'boot', windowDays: null, lastSampleAt: null })
    render(<SettingsPage />)
    expect(screen.getByTestId('flash-rate').textContent).toBe('800 MB/day')
    expect(screen.getByText('average since boot (2 h ago)')).toBeTruthy()
    expect(screen.getByText('1.50 GB')).toBeTruthy()
    expect(screen.getByText('mmcblk0 · 32.0 GB')).toBeTruthy()
    expect(screen.getByText('At this rate, 9.13 full-card writes a year')).toBeTruthy()
  })

  it('names the averaging window once there is history', () => {
    data.set('flash', { available: true, device: 'mmcblk0', cardBytes: null, sinceBootBytes: 1e6, uptimeS: 9e5, bytesPerDay: 2.4e8, basis: 'history', windowDays: 7, lastSampleAt: '2026-10-31T00:00:00Z' })
    render(<SettingsPage />)
    expect(screen.getByText('7-day average')).toBeTruthy()
    expect(screen.getByText('mmcblk0')).toBeTruthy()
  })

  it('says when there is no SD card to measure', () => {
    data.set('flash', { available: false, device: null, cardBytes: null, sinceBootBytes: null, uptimeS: null, bytesPerDay: null, basis: null, windowDays: null, lastSampleAt: null })
    render(<SettingsPage />)
    expect(screen.getByText('No SD card counter on this machine')).toBeTruthy()
  })
})

const record = (o: Partial<{ ts: string, destination: 'download' | 'bucket', ok: boolean, detail: string, bytes: number }>) => ({ id: 1, ts: '2026-10-31T03:00:00Z', destination: 'bucket', name: 'seedypod-backup-u-20261031-030000.tar.gz', bytes: 2_400_000, ok: true, detail: '', ...o })
const backup = (o: Record<string, unknown> = {}) => ({ available: true, lastSuccess: null, lastBucketAttempt: null, nightly: { enabled: false, hour: 3, keep: 14 }, staleAfterDays: 7, stale: false, recent: [], ...o })

describe('Settings: backup', () => {
  it('offers a download with the secrets warning, and photos on request', () => {
    data.set('backup', backup())
    render(<SettingsPage />)
    expect(screen.getByTestId('backup-last').textContent).toBe('none yet')
    expect(screen.getByText('The file holds your bucket secret, MQTT password and HomeKit pairing keys. Keep it somewhere private.')).toBeTruthy()
    const link = () => screen.getByText('Download backup').closest('a') as HTMLAnchorElement
    expect(link().getAttribute('href')).toBe('/api/backup/download')
    fireEvent.click(screen.getByRole('switch', { name: 'Include photos in the download' }))
    expect(link().getAttribute('href')).toBe('/api/backup/download?photos=1')
    expect((screen.getByRole('button', { name: 'Back up now' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Set up the mirror under Off-device storage/)).toBeTruthy()
  })

  it('runs a bucket backup now and shows a failed nightly attempt', () => {
    data.set('backup', backup({ nightly: { enabled: true, hour: 3, keep: 14 }, lastSuccess: record({}), lastBucketAttempt: record({ ok: false, detail: '503 SlowDown' }) }))
    render(<SettingsPage />)
    expect(screen.getByText('After 03:00, keeping the last 14 · last try failed: 503 SlowDown')).toBeTruthy()
    expect(screen.getByTestId('backup-last').textContent).toMatch(/· bucket$/)
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }))
    expect(calls.run).toHaveBeenCalled()
  })

  it('says when backups are overdue', () => {
    data.set('backup', backup({ stale: true }))
    render(<SettingsPage />)
    expect(screen.getByText('None for 7 days or more')).toBeTruthy()
  })

  it('opens the restore panel on the saved bucket and asks before replacing the unit', () => {
    data.set('backup', backup({ nightly: { enabled: true, hour: 3, keep: 14 } }))
    data.set('restoreInfo', { available: true, status: null, undo: null })
    data.set('bucketList', [{ key: 'backups/seedypod-backup-kitchen-20261030-030000.tar.gz', name: 'seedypod-backup-kitchen-20261030-030000.tar.gz', unit: 'kitchen', createdAt: '2026-10-30T03:00:00Z', size: 2_400_000 }])
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup…' }))
    // The saved mirror is used: no bucket form.
    expect(screen.queryByText('List backups')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(calls.fromBucket).not.toHaveBeenCalled()
    expect(screen.getByText(/It replaces this unit's settings, schedules, rules and history, then restarts\. You can undo it afterwards\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Replace this unit' }))
    expect(calls.fromBucket).toHaveBeenCalledWith({ key: 'backups/seedypod-backup-kitchen-20261030-030000.tar.gz', config: undefined })
  })

  it('offers undo after a restore, then redo after an undo', () => {
    data.set('backup', backup())
    data.set('restoreInfo', { available: true, status: null, undo: { restoredAt: '2026-10-31T08:00:00Z', bundle: { createdAt: '2026-10-30T03:00:00Z', unit: null, core: null, schema: 7, photos: false }, undoneAt: null } })
    const { unmount } = render(<SettingsPage />)
    expect(screen.getByText(/^Restored the backup from .* Undo puts back what it replaced\.$/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo restore' })[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(calls.undo).toHaveBeenCalled()
    unmount()
    data.set('restoreInfo', { available: true, status: null, undo: { restoredAt: '2026-10-31T08:00:00Z', bundle: { createdAt: '2026-10-30T03:00:00Z', unit: null, core: null, schema: 7, photos: false }, undoneAt: '2026-10-31T09:00:00Z' } })
    render(<SettingsPage />)
    expect(screen.getAllByRole('button', { name: 'Redo restore' })).toHaveLength(1)
  })

  it('says where restore is not installed', () => {
    data.set('backup', backup())
    data.set('restoreInfo', { available: false, status: null, undo: null })
    render(<SettingsPage />)
    expect(screen.getByText('Not installed on this core: run scripts/install on the unit')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Restore from a backup…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('is hidden where there are no backups (demo)', () => {
    data.set('backup', backup({ available: false }))
    render(<SettingsPage />)
    expect(screen.queryByText('Download backup')).toBeNull()
    expect(screen.getByText('Backups are not available on this core.')).toBeTruthy()
  })
})

describe('Settings: Wi-Fi', () => {
  it('links to the Wi-Fi screen', () => {
    render(<SettingsPage />)
    expect((screen.getByText('Change network') as HTMLAnchorElement).getAttribute('href')).toBe('/wifi')
  })

  it('names the board hald runs on and the machine core runs on', () => {
    data.set('info', { coreVersion: '1.4.0', coreHost: { hostname: 'nas', arch: 'x64' }, halOnline: true, system: { halVersion: '0.1.0', model: 'gardyn 3.0', unitId: 'gardyn-1a2b', board: 'Raspberry Pi Zero W Rev 1.1' } })
    render(<SettingsPage />)
    expect(screen.getByText('Raspberry Pi Zero W Rev 1.1')).toBeTruthy()
    expect(screen.getByText('nas (x64)')).toBeTruthy()
  })
})

describe('Settings: off-device storage and analysis', () => {
  it('saves mirror settings and the masks toggle without the has* flags', () => {
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect bucket' }))
    fireEvent.change(field('Mirror endpoint'), { target: { value: 'https://r2.example.com' } })
    fireEvent.change(field('Bucket'), { target: { value: 'pods' } })
    fireEvent.change(field('Secret access key'), { target: { value: 'sk' } })
    fireEvent.click(screen.getByLabelText('Keep analysis masks'))
    fireEvent.click(screen.getByText('Save'))
    const patch = calls.update.mock.calls[0]?.[0] as Record<string, unknown>
    expect(patch).toMatchObject({ mirrorEndpoint: 'https://r2.example.com', mirrorBucket: 'pods', mirrorSecretAccessKey: 'sk', analysisArtifacts: true })
    for (const k of ['hasApiKey', 'hasMqttPassword', 'hasAnalysisIngestToken', 'hasMirrorSecret', 'updatedAt']) expect(patch).not.toHaveProperty(k)
    // Clearing a field turns it back off rather than saving an empty string.
    fireEvent.change(field('Mirror endpoint'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Save'))
    expect((calls.update.mock.calls[1]?.[0] as Record<string, unknown>).mirrorEndpoint).toBeNull()
  })

  it('generates an ingest token and shows it until saved', () => {
    render(<SettingsPage />)
    expect(screen.getByText(/POST \/api\/analyses\/results is off/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate ingest token' }))
    const input = field('Result ingest token')
    expect(input.type).toBe('text')
    expect(input.value).toMatch(/^[0-9a-f]{48}$/)
    expect(screen.getByText(/Copy it now/)).toBeTruthy()
  })

  it('tests and back-fills the mirror and shows its counters', () => {
    data.set('testResult', { ok: false, detail: 'mirror PUT x: 403 AccessDenied' })
    data.set('syncResult', { queued: 12 })
    data.set('settings', { ...settings, mirrorEndpoint: 'https://r2.example.com', mirrorBucket: 'pods' })
    render(<SettingsPage />)
    expect(screen.getByText('Copying photos to pods. Backups go there too.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect bucket' })).toBeNull()
    expect(screen.getByText('40 copied · 1 pending · 0 failed')).toBeTruthy()
    fireEvent.click(screen.getByText('Test'))
    fireEvent.click(screen.getByText('Copy existing photos'))
    expect(calls.test).toHaveBeenCalled()
    expect(calls.sync).toHaveBeenCalled()
    expect(screen.getByText('mirror PUT x: 403 AccessDenied')).toBeTruthy()
    expect(screen.getByText('Queued 12 files')).toBeTruthy()
  })

  it('explains an unconfigured mirror and hides controls where there is none', () => {
    data.set('mirror', { ...mirror, enabled: false, lastError: 'boom', failed: 1 })
    data.set('syncError', new Error('the mirror is not configured'))
    render(<SettingsPage />)
    expect(screen.getByText(/^Off\. Nothing leaves the unit/)).toBeTruthy()
    expect(screen.queryByText('Test')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect bucket' }))
    expect(screen.getByText(/off — save an endpoint/)).toBeTruthy()
    expect((screen.getByText('Test') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('the mirror is not configured')).toBeTruthy()
    cleanup()
    data.set('mirror', { ...mirror, available: false })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect bucket' }))
    expect(screen.queryByText('Copy existing photos')).toBeNull()
  })
})

describe('Settings: header and section nav', () => {
  it('names the unit, counts unsaved changes and saves them', () => {
    data.set('info', { coreVersion: 'dev', coreHost: null, halOnline: true, system: { halVersion: '0.0.0-sim', model: 'gardyn 3.0', unitId: 'sim-0001' } })
    render(<SettingsPage />)
    expect(screen.getByText('Gardyn · sim-0001')).toBeTruthy()
    expect(screen.queryByTestId('unsaved')).toBeNull()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Increase Full' }))
    expect(screen.getByTestId('unsaved').textContent).toBe('1 unsaved change')
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/Los_Angeles' } })
    expect(screen.getByTestId('unsaved').textContent).toBe('2 unsaved changes')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.update.mock.calls[0]?.[0]).toMatchObject({ waterFullCm: 5.5, timezone: 'America/Los_Angeles' })
  })

  it('keeps a timezone the browser does not list', () => {
    data.set('settings', { ...settings, timezone: 'Mars/Olympus' })
    render(<SettingsPage />)
    expect((screen.getByLabelText('Timezone') as HTMLSelectElement).value).toBe('Mars/Olympus')
  })

  it('lists every section and scrolls to the one picked', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    render(<SettingsPage />)
    const nav = screen.getByRole('navigation')
    const labels = Array.from(nav.querySelectorAll('button'), b => b.textContent)
    expect(labels).toEqual(['Unit', 'Tank', 'Reminders', 'Cameras', 'API access', 'Storage', 'SD card', 'Backup', 'Home Assistant', 'Apple Home', 'Wi-Fi', 'Updates', 'About'])
    for (const id of ['unit', 'tank', 'reminders', 'cameras', 'api', 'off-device', 'storage', 'backup', 'home-assistant', 'homekit', 'wifi', 'update', 'about']) expect(document.getElementById(id)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Backup' }))
    expect(scroll).toHaveBeenCalled()
    expect(window.location.hash).toBe('#backup')
    expect(screen.getByRole('button', { name: 'Backup' }).getAttribute('aria-current')).toBe('page')
  })

  it('highlights the section nearest the top as the page scrolls', () => {
    let cb: IntersectionObserverCallback = () => {}
    const observe = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(fn: IntersectionObserverCallback) { cb = fn }
      observe = observe
      disconnect = vi.fn()
    })
    render(<SettingsPage />)
    expect(observe).toHaveBeenCalledTimes(13)
    const entry = (id: string, isIntersecting: boolean) => ({ target: document.getElementById(id), isIntersecting }) as unknown as IntersectionObserverEntry
    act(() => cb([entry('cameras', true), entry('api', true)], {} as IntersectionObserver))
    expect(screen.getByRole('button', { name: 'Cameras' }).getAttribute('aria-current')).toBe('page')
    act(() => cb([entry('cameras', false)], {} as IntersectionObserver))
    expect(screen.getByRole('button', { name: 'API access' }).getAttribute('aria-current')).toBe('page')
    vi.unstubAllGlobals()
  })
})

describe('Settings: tank and API key', () => {
  it('shows the live reading and sets it as full', () => {
    data.set('sensors', { water_distance: { ts: '', value: 7.3, unit: 'cm', quality: 'good' }, water_level_pct: { ts: '', value: 83.4, unit: '%', quality: 'good' } })
    render(<SettingsPage />)
    expect(screen.getByTestId('tank-reading').textContent).toBe('Reading now: 7.3 cm, which is 83%.')
    fireEvent.click(screen.getByRole('button', { name: 'Set as full' }))
    expect(screen.getByText('7.5 cm')).toBeTruthy()
  })

  it('hides the reading without a distance sensor', () => {
    data.set('sensors', {})
    render(<SettingsPage />)
    expect(screen.queryByTestId('tank-reading')).toBeNull()
  })

  it('generates an API key and shows it until saved', () => {
    render(<SettingsPage />)
    expect(screen.getByText('Not set. Only devices on your network can connect.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate API key' }))
    const input = screen.getByLabelText('API key') as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value).toMatch(/^[0-9a-f]{48}$/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((calls.update.mock.calls[0]?.[0] as Record<string, unknown>).apiKey).toBe(input.value)
  })

  it('says when a key is already set', () => {
    data.set('settings', { ...settings, hasApiKey: true })
    render(<SettingsPage />)
    expect(screen.getByText('Set. Clients off this network must send it.')).toBeTruthy()
  })
})

describe('Settings: grow reminders', () => {
  const cycle = (issued: string[]) => ({ cycle: { id: 'c', startedAt: '2026-10-13T12:00:00Z', endedAt: null, stage: 'vegetative', notes: '', issued }, day: 20 })

  it('marks today on the timeline and says where each reminder stands', () => {
    data.set('grow', cycle(['reminder_thinning']))
    render(<SettingsPage />)
    const timeline = screen.getByTestId('reminder-timeline')
    expect(timeline.textContent).toContain('today · 20')
    expect(timeline.textContent).toContain('40')
    expect(screen.getByText('Sent · day 14')).toBeTruthy()
    expect(screen.getByText('In 1 day')).toBeTruthy()
    expect(screen.getByText('In 15 days')).toBeTruthy()
    // Next nutrient period is day 21: 13 Oct + 21 days.
    expect(screen.getByText(`Recurring · next ${new Date('2026-11-03T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Root check' }))
    expect(screen.getByText('Due now')).toBeTruthy()
  })

  it('says off for a zero day and drops the timeline without a cycle', () => {
    data.set('settings', { ...settings, harvestReminderDays: 0, nutrientReminderDays: 0 })
    data.set('grow', { cycle: null, day: null })
    render(<SettingsPage />)
    expect(screen.queryByTestId('reminder-timeline')).toBeNull()
    expect(screen.getAllByText('Off')).toHaveLength(2)
  })

  it('calls nutrients recurring before a cycle starts', () => {
    render(<SettingsPage />)
    expect(screen.getByText('Recurring')).toBeTruthy()
  })
})

describe('Settings: every field saves', () => {
  it('collects unit, tank, reminder, camera, key, bucket and MQTT edits into one patch', () => {
    render(<SettingsPage />)
    fireEvent.change(field('Name'), { target: { value: 'Kitchen' } })
    fireEvent.click(screen.getByRole('tab', { name: '°F' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Empty' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Capacity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Harvest' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Nutrients' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Capture interval' }))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k1' } })
    fireEvent.change(screen.getByLabelText('Result ingest token'), { target: { value: 't1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect bucket' }))
    fireEvent.change(field('Region'), { target: { value: '' } })
    fireEvent.change(field('Key prefix'), { target: { value: 'kitchen/' } })
    fireEvent.change(field('Access key id'), { target: { value: 'AK' } })
    fireEvent.change(field('Broker URL'), { target: { value: 'mqtt://ha:1883' } })
    fireEvent.change(field('Username'), { target: { value: 'ha' } })
    fireEvent.change(field('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('switch', { name: 'TLS' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Allow self-signed' }))
    expect(screen.getByTestId('unsaved').textContent).toBe('16 unsaved changes')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.update.mock.calls[0]?.[0]).toMatchObject({
      unitName: 'Kitchen', temperatureUnit: 'F', waterEmptyCm: 20.5, tankCapacityL: 18, harvestReminderDays: 36, nutrientReminderDays: 8,
      captureIntervalMin: 75, apiKey: 'k1', analysisIngestToken: 't1', mirrorRegion: 'auto', mirrorPrefix: 'kitchen/', mirrorAccessKeyId: 'AK',
      mqttUrl: 'mqtt://ha:1883', mqttUsername: 'ha', mqttPassword: 'pw', mqttTlsEnabled: true, mqttTlsInsecure: true,
    })
  })
})
