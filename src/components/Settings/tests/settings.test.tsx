// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../SettingsPage'

const { data, calls } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { update: vi.fn(), test: vi.fn(), sync: vi.fn() },
}))

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children, className }: { to: string, children: unknown, className?: string }) => <a href={to} className={className}>{children as string}</a> }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name), refetch: vi.fn() }) })
  const mutation = (name: 'update' | 'test' | 'sync') => ({ useMutation: () => ({
    isPending: false,
    data: data.get(`${name}Result`),
    error: data.get(`${name}Error`) ?? null,
    mutate: (input?: unknown) => calls[name](input),
  }) })
  return {
    trpc: {
      useUtils: () => ({ settings: { invalidate: vi.fn() } }),
      settings: { get: query('settings'), update: mutation('update') },
      system: { info: query('info') },
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
