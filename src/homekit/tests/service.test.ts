import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../hardware/contract'
import { SimHal } from '../../hardware/sim'
import type { HalEvent } from '../../hardware/types'
import { createEventBus, type CoreEvent } from '../../lib/eventBus'
import { createCore } from '../../server/bootstrap'
import { MemoryStore } from '../../store/memory'
import type { BridgeOptions, PublishedBridge } from '../bridge'
import { DEFAULT_PORT, HomeKitService, legacyStorageDir, pickAdvertiser, pickBind, pickPort } from '../service'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'homekit-svc-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const unit = (o: Partial<SystemInfo> = {}): SystemInfo => ({
  contract: 1, unitId: 'gardyn-1a2b3c4d', model: 'gardyn 3.0', halVersion: '0.4.0',
  caps: { sensors: [], actuators: [], cameras: [] }, limits: { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 }, ...o,
})

/** A stand-in for the hap-nodejs side that records what it was asked to publish. */
function fakeBridge() {
  const published: BridgeOptions[] = []
  const live = new Set<BridgeOptions>()
  const fail = { next: null as Error | null }
  const unpublish = vi.fn()
  return {
    published, live, fail, unpublish,
    load: async () => ({
      hapName: (n: string) => n,
      publishBridge: async (o: BridgeOptions): Promise<PublishedBridge> => {
        if (fail.next) {
          const e = fail.next
          fail.next = null
          throw e
        }
        published.push(o)
        live.add(o)
        return {
          setupURI: `X-HM://${o.identity.setupId}`,
          unpublish: async () => {
            unpublish(o.identity.username)
            live.delete(o)
          },
        }
      },
    }),
  }
}

function setup(o: { system?: SystemInfo | null, enabled?: boolean, systemWaitMs?: number, dir?: string, legacyDir?: string | null } = {}) {
  const hal = new SimHal({ tickMs: 0 })
  const system = o.system === undefined ? unit() : o.system
  const snapshot = hal.snapshot.bind(hal)
  let reported = system
  hal.snapshot = () => ({ ...snapshot(), system: reported })
  const listeners = new Set<(e: HalEvent) => void>()
  const subscribe = hal.subscribe.bind(hal)
  hal.subscribe = (l) => {
    listeners.add(l)
    const off = subscribe(l)
    return () => {
      listeners.delete(l)
      off()
    }
  }
  const report = (s: SystemInfo) => {
    reported = s
    for (const l of listeners) l({ type: 'system', system: s })
  }
  const store = new MemoryStore()
  if (o.enabled) store.settings.update({ homekitEnabled: true })
  const events = createEventBus()
  const seen: CoreEvent[] = []
  events.subscribe(e => seen.push(e))
  const bridge = fakeBridge()
  const log: string[] = []
  const svc = new HomeKitService({
    store, hal, events, dir: o.dir ?? dir, legacyDir: o.legacyDir, version: 'test', env: {},
    readFile: () => {
      throw new Error('ENOENT')
    },
    loadBridge: bridge.load,
    renderQr: async uri => `<svg>${uri}</svg>`,
    systemWaitMs: o.systemWaitMs ?? 50,
    log: m => log.push(m),
  })
  const core = createCore({ hal, store, events, version: 'test', homekit: svc })
  return { svc, store, events, seen, bridge, log, core, hal, report, listeners }
}

const accessoryInfo = (username: string, clients: string[], at = dir) =>
  writeFileSync(join(at, `AccessoryInfo.${username.replace(/:/g, '')}.json`), JSON.stringify({ pairedClients: Object.fromEntries(clients.map(c => [c, {}])) }))

describe('HomeKitService', () => {
  it('is off by default: no bridge, no identity, nothing loaded at boot', async () => {
    const { svc, bridge, core } = setup()
    await svc.startIfEnabled()
    expect(bridge.published).toEqual([])
    expect(existsSync(join(dir, 'identity.json'))).toBe(false)
    expect(await svc.status()).toEqual({ enabled: false, running: false, transitioning: false, setupCode: null, setupURI: null, qrSvg: null, pairedControllers: 0, error: null })
    expect(core.ctx.homekit).toBe(svc)
  })

  it('turning it on derives the unit\'s identity, publishes, saves the switch and tells the UI', async () => {
    const { svc, store, bridge, seen, log } = setup()
    const s = await svc.setEnabled(true)
    expect(bridge.published).toHaveLength(1)
    const o = bridge.published[0] as BridgeOptions
    expect(o).toMatchObject({ dir, port: DEFAULT_PORT, advertiser: 'ciao', bind: undefined, name: 'Gardyn', version: 'test' })
    expect(o.identity).toMatchObject({ derivedFrom: 'hal-unit-id', rotation: 0 })
    expect(s).toMatchObject({ enabled: true, running: true, transitioning: false, setupCode: o.identity.pincode, setupURI: `X-HM://${o.identity.setupId}`, qrSvg: `<svg>X-HM://${o.identity.setupId}</svg>`, error: null })
    expect(store.settings.get().homekitEnabled).toBe(true)
    expect(seen).toContainEqual({ kind: 'mutation', path: 'homekit' })
    expect(log.join('\n')).not.toContain(o.identity.pincode)
    expect(log.join('\n')).not.toContain(o.identity.setupId)
    // Turning it on again is a no-op.
    await svc.setEnabled(true)
    expect(bridge.published).toHaveLength(1)
  })

  it('accessories write through core\'s caller (the app\'s safety path)', async () => {
    const { svc, bridge, hal } = setup()
    await svc.setEnabled(true)
    const { api } = (bridge.published[0] as BridgeOptions).deps
    await api.light.set({ level: 33 })
    expect(hal.snapshot().actuators.light).toMatchObject({ on: true, level: 33 })
  })

  it('a failed start leaves it off, says why, and the next try starts cleanly', async () => {
    const { svc, store, bridge } = setup()
    bridge.fail.next = new Error('listen EADDRINUSE :::51827')
    await expect(svc.setEnabled(true)).rejects.toThrow('EADDRINUSE')
    expect(store.settings.get().homekitEnabled).toBe(false)
    expect(await svc.status()).toMatchObject({ enabled: false, running: false, transitioning: false, error: 'listen EADDRINUSE :::51827' })
    expect((await svc.setEnabled(true)).error).toBeNull()
  })

  it('turning it off unpublishes and saves the switch; shutdown unpublishes but keeps it', async () => {
    const { svc, store, bridge, core } = setup()
    await svc.setEnabled(true)
    expect((await svc.setEnabled(false))).toMatchObject({ enabled: false, running: false, setupURI: null, qrSvg: null })
    expect(bridge.live.size).toBe(0)
    expect(store.settings.get().homekitEnabled).toBe(false)
    await svc.setEnabled(true)
    await core.stop()
    expect(bridge.live.size).toBe(0)
    expect(store.settings.get().homekitEnabled).toBe(true)
  })

  it('starts on boot when left on, and logs (not throws) a failure', async () => {
    const a = setup({ enabled: true })
    await a.svc.startIfEnabled()
    expect(a.bridge.live.size).toBe(1)
    const b = setup({ enabled: true })
    b.bridge.fail.next = new Error('mDNS down')
    await b.svc.startIfEnabled()
    expect(b.log).toContain('homekit: not started: mDNS down')
    expect((await b.svc.status()).error).toBe('mDNS down')
  })

  it('runs one lifecycle change at a time', async () => {
    const { svc, bridge } = setup()
    await Promise.all([svc.setEnabled(true), svc.setEnabled(true), svc.resetPairing(), svc.setEnabled(false), svc.setEnabled(true)])
    expect(bridge.live.size).toBe(1)
    expect(bridge.published).toHaveLength(3)
  })

  it('reset removes the pairings and rotates to a new code and QR, restarting if on', async () => {
    const { svc, bridge } = setup()
    const before = await svc.setEnabled(true)
    const old = (bridge.published[0] as BridgeOptions).identity
    accessoryInfo(old.username, ['ios-1'])
    expect((await svc.status()).pairedControllers).toBe(1)
    const after = await svc.resetPairing()
    expect(bridge.unpublish).toHaveBeenCalledWith(old.username)
    expect(existsSync(join(dir, `AccessoryInfo.${old.username.replace(/:/g, '')}.json`))).toBe(false)
    expect(after.setupCode).not.toBe(before.setupCode)
    expect(after.setupURI).not.toBe(before.setupURI)
    expect(after).toMatchObject({ running: true, pairedControllers: 0 })
    expect((bridge.published[1] as BridgeOptions).identity.rotation).toBe(1)
    // Off: rotates without starting.
    await svc.setEnabled(false)
    const off = await svc.resetPairing()
    expect(off).toMatchObject({ running: false, enabled: false })
    expect(bridge.published).toHaveLength(2)
  })

  it('pairing marks the identity, and a boot into an existing pairing marks it too', async () => {
    const { svc, bridge, seen } = setup()
    await svc.setEnabled(true)
    const o = bridge.published[0] as BridgeOptions
    seen.length = 0
    o.onPaired()
    expect(svc.ids.read()?.wasPaired).toBe(true)
    expect(seen).toEqual([{ kind: 'mutation', path: 'homekit' }])

    const again = setup({ enabled: true })
    const id = again.svc.ids.loadOrCreate()
    accessoryInfo(id.username, ['ios-1'])
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({ ...id, wasPaired: false }))
    await again.svc.startIfEnabled()
    expect(again.svc.ids.read()?.wasPaired).toBe(true)
  })

  it('a relative data dir reports the pairings hap-nodejs wrote, and hands hap-nodejs the absolute path', async () => {
    const { svc, bridge } = setup({ enabled: true, dir: relative(process.cwd(), dir), legacyDir: null })
    const id = svc.ids.loadOrCreate()
    accessoryInfo(id.username, ['ios-1', 'hub-1'])
    await svc.startIfEnabled()
    expect((bridge.published[0] as BridgeOptions).dir).toBe(dir)
    expect((await svc.status()).pairedControllers).toBe(2)
  })

  it('moves pairings an older core left under node-persist, so a paired unit stays paired', async () => {
    const legacy = join(dir, 'legacy')
    mkdirSync(legacy)
    const { svc, bridge, log } = setup({ enabled: true, legacyDir: legacy })
    const id = svc.ids.loadOrCreate()
    svc.ids.markPaired()
    const key = id.username.replace(/:/g, '')
    accessoryInfo(id.username, ['ios-1', 'hub-1'], legacy)
    writeFileSync(join(legacy, `IdentifierCache.${key}.json`), '{}')
    await svc.startIfEnabled()
    expect((bridge.published[0] as BridgeOptions).identity.username).toBe(id.username)
    expect((await svc.status()).pairedControllers).toBe(2)
    expect(existsSync(join(dir, `IdentifierCache.${key}.json`))).toBe(true)
    expect(readdirSync(legacy)).toEqual([])
    expect(log.join('\n')).toMatch(/moved .* pairings from/)
  })

  it('keeps its own pairing files over leftovers under node-persist', async () => {
    const legacy = join(dir, 'legacy')
    mkdirSync(legacy)
    const { svc } = setup({ enabled: true, legacyDir: legacy })
    const id = svc.ids.loadOrCreate()
    accessoryInfo(id.username, ['ios-1'])
    accessoryInfo(id.username, ['old-1', 'old-2'], legacy)
    await svc.startIfEnabled()
    expect((await svc.status()).pairedControllers).toBe(1)
    expect(readdirSync(legacy)).toHaveLength(1)
  })

  it('finds where node-persist puts a relative storage path', () => {
    const req = createRequire(createRequire(import.meta.url).resolve('hap-nodejs'))
    const persist = req('node-persist') as { create(): { setOptions(o: { dir: string }): void, options: { dir: string } } }
    const store = persist.create()
    store.setOptions({ dir: 'data/homekit' })
    expect(legacyStorageDir('./data/homekit')).toBe(store.options.dir)
    expect(legacyStorageDir(dir)).toBeNull()
    expect(legacyStorageDir('data/homekit', () => {
      throw new Error('MODULE_NOT_FOUND')
    })).toBeNull()
  })

  it('a bridge removed from Home while core was down gets a new identity before it publishes', async () => {
    const { svc, bridge, log } = setup({ enabled: true })
    const id = svc.ids.loadOrCreate()
    svc.ids.markPaired()
    accessoryInfo(id.username, [])
    await svc.startIfEnabled()
    const published = (bridge.published[0] as BridgeOptions).identity
    expect(published.username).not.toBe(id.username)
    expect(published.rotation).toBe(1)
    expect(log.join('\n')).toMatch(/removed from Home while core was down/)
  })

  it('a removal from Home while running rotates once hap-nodejs has answered', async () => {
    vi.useFakeTimers()
    const { svc, bridge } = setup()
    await svc.setEnabled(true)
    const o = bridge.published[0] as BridgeOptions
    o.onPaired()
    accessoryInfo(o.identity.username, [])
    o.onUnpaired()
    o.onUnpaired()
    expect(bridge.published).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(bridge.published).toHaveLength(2)
    expect((bridge.published[1] as BridgeOptions).identity.username).not.toBe(o.identity.username)

    // Not stranded (another controller still paired): nothing happens.
    const p = bridge.published[1] as BridgeOptions
    p.onPaired()
    accessoryInfo(p.identity.username, ['ios-2'])
    p.onUnpaired()
    await vi.advanceTimersByTimeAsync(1000)
    expect(bridge.published).toHaveLength(2)
  })

  it('a pending rotation is dropped on shutdown', async () => {
    vi.useFakeTimers()
    const { svc, bridge } = setup()
    await svc.setEnabled(true)
    const o = bridge.published[0] as BridgeOptions
    o.onPaired()
    accessoryInfo(o.identity.username, [])
    o.onUnpaired()
    await svc.shutdown()
    await vi.advanceTimersByTimeAsync(2000)
    expect(bridge.published).toHaveLength(1)
  })

  it('a first start waits briefly for hald\'s unit id, the preferred seed', async () => {
    const { svc, bridge, report, listeners } = setup({ system: null, systemWaitMs: 5000 })
    const baseline = listeners.size
    const started = svc.setEnabled(true)
    await new Promise(r => setTimeout(r, 10))
    report(unit({ unitId: 'gardyn-late' }))
    await started
    expect((bridge.published[0] as BridgeOptions).identity.derivedFrom).toBe('hal-unit-id')
    expect(listeners.size).toBe(baseline)
  })

  it('without hald it gives up waiting and derives from what this machine has', async () => {
    const { svc, bridge } = setup({ system: null, systemWaitMs: 20 })
    await svc.setEnabled(true)
    expect((bridge.published[0] as BridgeOptions).identity.derivedFrom).toBe('random')
  })

  it('refuses to start before it is attached to core', async () => {
    const svc = new HomeKitService({ store: new MemoryStore(), hal: new SimHal({ tickMs: 0 }), events: createEventBus(), dir, version: 't', loadBridge: fakeBridge().load, log: () => undefined })
    await expect(svc.setEnabled(true)).rejects.toThrow('not attached')
  })

  it('opens the HAP debug window on request and shuts it when core stops', async () => {
    const { svc } = setup()
    const hapDebug = { set: vi.fn(() => ({ until: '2026-11-09T10:05:00.000Z' })), off: vi.fn() }
    Object.assign(svc, { hapDebug })
    expect(svc.debug(5)).toEqual({ until: '2026-11-09T10:05:00.000Z' })
    expect(hapDebug.set).toHaveBeenCalledWith(5)
    await svc.shutdown()
    expect(hapDebug.off).toHaveBeenCalledWith('core stopping')
  })

  it('reports which seed the unit resolves to, without values', async () => {
    const { svc } = setup()
    expect(svc.seedProbe()).toMatchObject({ resolved: 'hal-unit-id', identity: null })
    await svc.setEnabled(true)
    const probe = svc.seedProbe()
    expect(probe.identity).toMatchObject({ derivedFrom: 'hal-unit-id', rotation: 0 })
    expect(JSON.stringify(probe)).not.toMatch(/gardyn-1a2b3c4d|\d{3}-\d{2}-\d{3}/)
  })
})

describe('environment knobs', () => {
  it('advertiser: ciao unless HOMEKIT_ADVERTISER names another hap-nodejs supports', () => {
    expect(pickAdvertiser({})).toBe('ciao')
    expect(pickAdvertiser({ HOMEKIT_ADVERTISER: 'avahi' })).toBe('avahi')
    expect(pickAdvertiser({ HOMEKIT_ADVERTISER: 'bonjour-hap' })).toBe('bonjour-hap')
    expect(pickAdvertiser({ HOMEKIT_ADVERTISER: 'resolved' })).toBe('resolved')
    expect(pickAdvertiser({ HOMEKIT_ADVERTISER: 'bogus' })).toBe('ciao')
  })

  it('bind and port', () => {
    expect(pickBind({})).toBeUndefined()
    expect(pickBind({ HOMEKIT_BIND: ' wlan0, eth0 ,' })).toEqual(['wlan0', 'eth0'])
    expect(pickPort({})).toBe(51827)
    expect(pickPort({ HOMEKIT_PORT: '51900' })).toBe(51900)
    expect(pickPort({ HOMEKIT_PORT: '0' })).toBe(51827)
    expect(pickPort({ HOMEKIT_PORT: 'x' })).toBe(51827)
  })

  it('the default QR is a real SVG', async () => {
    const { store, events } = setup()
    const svc = new HomeKitService({ store, hal: new SimHal({ tickMs: 0 }), events, dir, version: 't', env: { HOMEKIT_PORT: '51999' }, loadBridge: fakeBridge().load, log: () => undefined })
    createCore({ hal: new SimHal({ tickMs: 0 }), store, events, version: 't', homekit: svc })
    const s = await svc.setEnabled(true)
    expect(s.qrSvg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    expect((await svc.status()).qrSvg).toBe(s.qrSvg)
  })
})
