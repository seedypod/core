import { describe, expect, it, vi } from 'vitest'
import type { BackupService } from '../../backup/service'
import type { MirroredSink } from '../../camera/mirrorSink'
import { demoDatabase } from '../../demo/database'
import type { HalSnapshot } from '../../hardware/types'
import { SimHal } from '../../hardware/sim'
import type { HomeKitControl, HomeKitStatus } from '../../homekit/types'
import { createEventBus } from '../../lib/eventBus'
import type { BridgeStatus } from '../../mqtt/bridge'
import { SimWifi, type WifiStatus } from '../../network/wifi'
import { MemoryStore } from '../../store/memory'
import { bytes } from '../checks'
import { createCore, type CoreOptions } from '../bootstrap'
import { openApiDocument } from '../openapi'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

const NOW = new Date('2026-11-01T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString()
const HK: HomeKitStatus = { enabled: true, running: true, transitioning: false, setupCode: null, setupURI: null, qrSvg: null, pairedControllers: 2, error: null }

function rig(o: Omit<Partial<CoreOptions>, 'homekit' | 'wifi'> & { homekit?: HomeKitControl, snap?: (s: HalSnapshot) => HalSnapshot, wifi?: Partial<WifiStatus> | null } = {}) {
  const hal = new SimHal({ tickMs: 0, now: () => NOW })
  const base = hal.snapshot.bind(hal)
  hal.snapshot = () => (o.snap ?? (s => s))(base())
  const store = new MemoryStore()
  const wifi = new SimWifi(o.wifi !== null)
  if (o.wifi) {
    const real = wifi.status.bind(wifi)
    wifi.status = async () => ({ ...await real(), ...o.wifi })
  }
  const homekit = o.homekit && { ...o.homekit, attach: vi.fn(), shutdown: vi.fn(async () => undefined) }
  const core = createCore({ hal, store, events: createEventBus(), version: 'test', now: () => NOW, ...o, wifi, homekit })
  const c = createCallerFactory(appRouter)(core.ctx)
  const checks = async () => Object.fromEntries((await c.system.checks()).checks.map(k => [k.id, k]))
  return { c, store, core, checks }
}

const homekit = (s: Partial<HomeKitStatus>) => ({ status: async () => ({ ...HK, ...s }) }) as unknown as HomeKitControl
const backup = (s: { lastSuccess?: { ts: string } | null, stale?: boolean, nightly?: boolean }) =>
  ({ status: () => ({ lastSuccess: s.lastSuccess ?? null, stale: s.stale ?? false, nightly: { enabled: s.nightly ?? false } }) }) as unknown as BackupService
const mirror = (s: { enabled: boolean, uploaded?: number, pending?: number, lastError?: string | null }) =>
  ({ status: () => ({ uploaded: 0, pending: 0, failed: 0, lastError: null, lastUploadAt: null, ...s }) }) as unknown as MirroredSink

describe('storage.database', () => {
  it('reports the scan and runs integrity checks through the inspector', async () => {
    const { c } = rig({ database: demoDatabase(() => NOW) })
    const r = await c.storage.database()
    expect(r.integrity).toBeNull()
    expect(r.tables.map(t => t.name)).toContain('telemetry')
    const run = await c.storage.checkDatabase()
    expect(run).toMatchObject({ ok: true })
    expect((await c.storage.database()).integrity).toEqual(run)
  })

  it('says so on a core with no inspector', async () => {
    const { c } = rig()
    await expect(c.storage.database()).rejects.toThrow('no database inspector')
    await expect(c.storage.checkDatabase()).rejects.toThrow('no database inspector')
  })

  it('is in the REST API, for reads and the integrity check', () => {
    const paths = openApiDocument('http://localhost:3000/api').paths ?? {}
    expect(paths['/storage/database']?.get).toBeDefined()
    expect(paths['/storage/database/integrity']?.post).toBeDefined()
  })
})

describe('system.checks', () => {
  it('lists every part of the unit in a fixed order, with the host-only services idle in tests', async () => {
    const { c, store } = rig()
    store.captures.add({ id: 'c1', camera: 'upper', ts: iso(5), path: 'x', bytes: 10 })
    const { checks } = await c.system.checks()
    expect(checks.map(k => k.id)).toEqual(['hal', 'sensors', 'light', 'pump', 'cameras', 'autopilot', 'network', 'storage', 'backup', 'mirror', 'homekit', 'bridge'])
    const by = Object.fromEntries(checks.map(k => [k.id, k]))
    expect(by.hal).toMatchObject({ label: 'Hardware daemon', state: 'ok', detail: 'gardyn 3.0 (sim) · hald 0.0.0-sim' })
    expect(by.sensors).toMatchObject({ state: 'ok', detail: '8 of 8 reporting' })
    expect(by.light).toMatchObject({ state: 'ok', detail: 'Off' })
    expect(by.pump).toMatchObject({ state: 'ok', detail: 'Resting' })
    expect(by.cameras).toMatchObject({ state: 'ok', detail: '2 cameras · last photo 5 min ago', since: iso(5) })
    expect(by.network).toMatchObject({ state: 'ok', detail: 'Home · 192.168.1.40' })
    for (const id of ['storage', 'backup', 'mirror', 'homekit', 'bridge']) expect(by[id].state).toBe('idle')
    expect(by.bridge.detail).toBe('No broker set')
  })

  it('marks the daemon, sensors and outputs down when hald is offline', async () => {
    const { checks, store } = rig({ snap: s => ({ ...s, online: false, actuators: {} }) })
    store.alerts.raise('hal_offline', 'hardware daemon unreachable', iso(3))
    const k = await checks()
    expect(k.hal).toMatchObject({ state: 'down', detail: 'Not answering', since: iso(3) })
    expect(k.sensors).toMatchObject({ state: 'down', detail: 'No readings while the daemon is offline' })
    expect(k.light).toMatchObject({ state: 'down', detail: 'Unknown while the daemon is offline' })
  })

  it('names stale sensors, and goes down when none report', async () => {
    const partial = await rig({ snap: s => ({ ...s, system: s.system && { ...s.system, caps: { ...s.system.caps, sensors: ['air_temp', 'humidity', 'ph'] } }, sensors: { ...s.sensors, humidity: { ts: iso(30), value: 50, unit: '%', quality: 'good' } } }) }).checks()
    expect(partial.sensors).toMatchObject({ state: 'stalled', detail: '1 of 3 reporting · humidity, ph stale', since: iso(30) })
    const none = await rig({ snap: s => ({ ...s, sensors: {} }) }).checks()
    expect(none.sensors).toMatchObject({ state: 'down', detail: 'No fresh readings', since: null })
    const empty = await rig({ snap: s => ({ ...s, system: null }) }).checks()
    expect(empty.sensors).toMatchObject({ state: 'down', detail: 'No sensors configured' })
    expect(empty.hal.detail).toBe('Online')
  })

  it('reports a latched output fault, a running pump, a lit light, and an output the unit lacks', async () => {
    const { checks, store } = rig({
      snap: s => ({ ...s, actuators: { light: { on: true, level: 80, since: iso(60), fault: null, remainingS: null }, pump: { on: true, level: 30, since: iso(1), fault: null, remainingS: 42 } } }),
    })
    let k = await checks()
    expect(k.light).toMatchObject({ state: 'ok', detail: 'On · 80%', since: iso(60) })
    expect(k.pump).toMatchObject({ state: 'ok', detail: 'Running · 42 s left' })
    store.alerts.raise('pump_fault', 'dry run', iso(2))
    const faulty = rig({ snap: s => ({ ...s, actuators: { pump: { on: false, level: 0, since: iso(2), fault: 'dry run', remainingS: null } } }) })
    faulty.store.alerts.raise('pump_fault', 'dry run', iso(2))
    k = await faulty.checks()
    expect(k.pump).toMatchObject({ state: 'down', detail: 'dry run', since: iso(2) })
    expect(k.light).toMatchObject({ state: 'idle', detail: 'Not on this unit' })
    const bare = await rig({ snap: s => ({ ...s, actuators: { pump: { on: true, level: 30, since: iso(1), fault: null, remainingS: null } } }) }).checks()
    expect(bare.pump.detail).toBe('Running')
  })

  it('follows the cameras: missing, none fitted, photos off, none yet, behind', async () => {
    const missing = rig()
    missing.store.alerts.raise('camera_missing', 'upper camera returned 0 bytes', iso(4))
    expect((await missing.checks()).cameras).toMatchObject({ state: 'down', detail: 'upper camera returned 0 bytes', since: iso(4) })
    const none = await rig({ snap: s => ({ ...s, system: s.system && { ...s.system, caps: { ...s.system.caps, cameras: [] } } }) }).checks()
    expect(none.cameras).toMatchObject({ state: 'idle', detail: 'No cameras on this unit' })
    const off = rig()
    off.store.settings.update({ captureIntervalMin: 0 })
    expect((await off.checks()).cameras).toMatchObject({ state: 'idle', detail: 'Periodic photos off' })
    expect((await rig().checks()).cameras).toMatchObject({ state: 'stalled', detail: 'No photos yet' })
    const behind = rig({ snap: s => ({ ...s, system: s.system && { ...s.system, caps: { ...s.system.caps, cameras: ['upper'] } } }) })
    behind.store.captures.add({ id: 'c1', camera: 'upper', ts: iso(180), path: 'x', bytes: 10 })
    expect((await behind.checks()).cameras).toMatchObject({ state: 'stalled', detail: 'Last photo 3 h ago' })
    behind.store.captures.add({ id: 'c2', camera: 'upper', ts: iso(10), path: 'x', bytes: 10 })
    expect((await behind.checks()).cameras.detail).toBe('1 camera · last photo 10 min ago')
  })

  it('reads Autopilot off, not yet run, behind, and ticking', async () => {
    const r = rig()
    const status = vi.spyOn(r.core.ctx.autopilot, 'status')
    const s = { leases: [], rules: [] }
    status.mockReturnValue({ ...s, enabled: false, lastTickAt: null })
    expect((await r.checks()).autopilot).toMatchObject({ state: 'idle', detail: 'Off' })
    status.mockReturnValue({ ...s, enabled: true, lastTickAt: null })
    expect((await r.checks()).autopilot).toMatchObject({ state: 'stalled', detail: 'Has not run yet' })
    status.mockReturnValue({ ...s, enabled: true, lastTickAt: iso(3 * 24 * 60) })
    expect((await r.checks()).autopilot).toMatchObject({ state: 'stalled', detail: 'Last ran 3 d ago' })
    status.mockReturnValue({ ...s, enabled: true, lastTickAt: iso(0), rules: [{ id: 'r1' }] as never })
    expect((await r.checks()).autopilot).toMatchObject({ state: 'ok', detail: '1 rule · ran just now' })
    status.mockReturnValue({ ...s, enabled: true, lastTickAt: iso(2) })
    expect((await r.checks()).autopilot.detail).toBe('0 rules · ran 2 min ago')
  })

  it('reads Wi-Fi: unmanaged, setup hotspot, offline, connected without an address', async () => {
    expect((await rig({ wifi: null }).checks()).network).toMatchObject({ state: 'idle', detail: 'Not managed on this host' })
    expect((await rig({ wifi: { mode: 'setup', setup: { ssid: 'seedypod-setup', url: 'x', until: iso(0) } } }).checks()).network).toMatchObject({ state: 'stalled', detail: 'Setup hotspot seedypod-setup up' })
    expect((await rig({ wifi: { mode: 'setup', setup: null } }).checks()).network.detail).toBe('Setup hotspot up')
    expect((await rig({ wifi: { mode: 'offline', lastError: 'wrong password' } }).checks()).network).toMatchObject({ state: 'down', detail: 'wrong password' })
    expect((await rig({ wifi: { mode: 'offline', lastError: null } }).checks()).network.detail).toBe('Not connected')
    expect((await rig({ wifi: { ssid: null, ip: null } }).checks()).network.detail).toBe('Connected')
  })

  it('grades free disk space: plenty, low, full', async () => {
    const at = (usedBytes: number, freeBytes: number) => rig({ disk: () => ({ usedBytes, freeBytes }) }).checks()
    expect((await at(20e9, 12e9)).storage).toMatchObject({ state: 'ok', detail: '12 GB free of 32 GB' })
    expect((await at(29e9, 3e9)).storage).toMatchObject({ state: 'stalled', detail: '3.0 GB free of 32 GB' })
    expect((await at(31e9, 1e9)).storage.state).toBe('down')
    expect((await at(0, 0)).storage.state).toBe('down')
  })

  it('reads backups: none yet, stale, recent', async () => {
    expect((await rig({ backup: backup({}) }).checks()).backup).toMatchObject({ state: 'stalled', detail: 'No backup yet' })
    expect((await rig({ backup: backup({ lastSuccess: { ts: iso(9 * 24 * 60) }, stale: true }) }).checks()).backup).toMatchObject({ state: 'stalled', detail: 'Last 9 d ago', since: iso(9 * 24 * 60) })
    expect((await rig({ backup: backup({ lastSuccess: { ts: iso(30) }, nightly: true }) }).checks()).backup).toMatchObject({ state: 'ok', detail: 'Last 30 min ago · nightly on' })
  })

  it('reads the off-device copy: off, failing, copying', async () => {
    expect((await rig({ mirror: mirror({ enabled: false }) }).checks()).mirror).toMatchObject({ state: 'idle', detail: 'Off' })
    const failing = rig({ mirror: mirror({ enabled: true, lastError: '403' }) })
    failing.store.alerts.raise('mirror_failed', 'copy failed', iso(1))
    expect((await failing.checks()).mirror).toMatchObject({ state: 'down', detail: '403', since: iso(1) })
    const noReason = rig({ mirror: mirror({ enabled: true }) })
    noReason.store.alerts.raise('mirror_failed', 'copy failed', iso(1))
    expect((await noReason.checks()).mirror.detail).toBe('Copy failed')
    expect((await rig({ mirror: mirror({ enabled: true, uploaded: 40, pending: 2 }) }).checks()).mirror).toMatchObject({ state: 'ok', detail: '40 copied · 2 pending' })
    expect((await rig({ mirror: mirror({ enabled: true, uploaded: 40 }) }).checks()).mirror.detail).toBe('40 copied')
  })

  it('reads HomeKit: off, starting, failed, running', async () => {
    expect((await rig({ homekit: homekit({ enabled: false }) }).checks()).homekit).toMatchObject({ state: 'idle', detail: 'Off' })
    expect((await rig({ homekit: homekit({ transitioning: true }) }).checks()).homekit).toMatchObject({ state: 'stalled', detail: 'Starting' })
    expect((await rig({ homekit: homekit({ running: false, error: 'port in use' }) }).checks()).homekit).toMatchObject({ state: 'down', detail: 'port in use' })
    expect((await rig({ homekit: homekit({ running: false }) }).checks()).homekit.detail).toBe('Not running')
    expect((await rig({ homekit: homekit({}) }).checks()).homekit).toMatchObject({ state: 'ok', detail: '2 paired' })
  })

  it('reads the Home Assistant bridge from the host, or from settings where there is none', async () => {
    const up: BridgeStatus = { state: 'connected', broker: '192.168.1.5:1883', since: iso(60), error: null }
    expect((await rig({ bridge: () => up }).checks()).bridge).toMatchObject({ state: 'ok', detail: '192.168.1.5:1883', since: iso(60) })
    expect((await rig({ bridge: () => ({ ...up, broker: null }) }).checks()).bridge.detail).toBe('Connected')
    expect((await rig({ bridge: () => ({ ...up, state: 'disconnected', error: 'ECONNREFUSED' }) }).checks()).bridge).toMatchObject({ state: 'down', detail: 'ECONNREFUSED' })
    const configured = rig()
    configured.store.settings.update({ mqttUrl: 'mqtt://broker.local:1883' })
    expect((await configured.checks()).bridge).toMatchObject({ state: 'down', detail: 'Not connected to broker.local:1883' })
    expect(await configured.c.system.bridge()).toEqual({ state: 'disconnected', broker: 'broker.local:1883', since: null, error: null })
    expect((await rig({ bridge: () => ({ state: 'disconnected', broker: null, since: null, error: null }) }).checks()).bridge.detail).toBe('Not connected to the broker')
    expect(await rig({ bridge: () => up }).c.system.bridge()).toEqual(up)
  })

  it('publishes the checks and bridge under /api/system, and storage.flash carries disk space', async () => {
    const paths = Object.keys(openApiDocument('http://localhost:3000/api').paths ?? {})
    expect(paths).toEqual(expect.arrayContaining(['/system/checks', '/system/bridge', '/storage/flash']))
    expect(await rig({ disk: () => ({ usedBytes: 5, freeBytes: 7 }) }).c.storage.flash()).toMatchObject({ usedBytes: 5, freeBytes: 7 })
  })
})

describe('settings.update', () => {
  it('keeps the telemetry flush interval between one minute and an hour', async () => {
    const { c } = rig()
    await expect(c.settings.update({ telemetryFlushMin: 0 })).rejects.toThrow()
    await expect(c.settings.update({ telemetryFlushMin: 61 })).rejects.toThrow()
    expect((await c.settings.update({ telemetryFlushMin: 10 })).telemetryFlushMin).toBe(10)
  })
})

describe('bytes', () => {
  it('scales by thousands with one decimal under ten', () => {
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1500)).toBe('1.5 KB')
    expect(bytes(64e9)).toBe('64 GB')
    expect(bytes(3e15)).toBe('3000 TB')
  })
})
