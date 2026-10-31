// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    expect(screen.getByText('The file holds your bucket secret and MQTT password. Keep it somewhere private.')).toBeTruthy()
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
  })
})

describe('Settings: Wi-Fi', () => {
  it('links to the Wi-Fi screen', () => {
    render(<SettingsPage />)
    expect((screen.getByText('Open Wi-Fi settings') as HTMLAnchorElement).getAttribute('href')).toBe('/wifi')
  })
})

describe('Settings: off-device storage and analysis', () => {
  it('saves mirror settings and the masks toggle without the has* flags', () => {
    render(<SettingsPage />)
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
    fireEvent.click(screen.getByText('Generate'))
    const input = field('Result ingest token')
    expect(input.type).toBe('text')
    expect(input.value).toMatch(/^[0-9a-f]{48}$/)
    expect(screen.getByText(/Copy it now/)).toBeTruthy()
  })

  it('tests and back-fills the mirror and shows its counters', () => {
    data.set('testResult', { ok: false, detail: 'mirror PUT x: 403 AccessDenied' })
    data.set('syncResult', { queued: 12 })
    render(<SettingsPage />)
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
    expect(screen.getByText(/off — save an endpoint/)).toBeTruthy()
    expect((screen.getByText('Test') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('the mirror is not configured')).toBeTruthy()
    cleanup()
    data.set('mirror', { ...mirror, available: false })
    render(<SettingsPage />)
    expect(screen.queryByText('Copy existing photos')).toBeNull()
  })
})
