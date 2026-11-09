import * as hap from 'hap-nodejs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import type { AccessoryDeps } from '../accessories/common'
import { buildBridge, type BridgeOptions, firmware, hapName, initStorage, publishBridge } from '../bridge'
import { deriveIdentity } from '../identity'

const identity = deriveIdentity({ resolved: 'hal-unit-id', value: 'gardyn-1a2b3c4d' }, 0)
const noop = () => Promise.reject(new Error('not in this test'))

function deps(): { deps: Omit<AccessoryDeps, 'hap'>, events: ReturnType<typeof createEventBus>, log: string[] } {
  const events = createEventBus()
  const log: string[] = []
  return { events, log, deps: { api: { light: { set: noop }, pump: { runOnce: noop, stop: noop }, camera: { capture: noop } }, hal: new SimHal({ tickMs: 0 }), events, stills: { latest: async () => null }, log: m => log.push(m) } }
}

function options(d: Omit<AccessoryDeps, 'hap'>, o: Partial<BridgeOptions> = {}): BridgeOptions {
  return { identity, dir: '/tmp/seedypod-homekit-bridge-test', deps: d, name: 'Kitchen', port: 51827, advertiser: 'ciao', version: 'v0.3.1-4-gabc', onPaired: vi.fn(), onUnpaired: vi.fn(), ...o }
}

afterEach(() => vi.restoreAllMocks())

describe('accessory tree', () => {
  it('one bridge with the light, pump, sensors and cameras, ids stable for the identity', () => {
    const { deps: d } = deps()
    const a = buildBridge({ identity, name: 'Kitchen', version: 'dev', deps: { ...d, hap } })
    const b = buildBridge({ identity, name: 'Kitchen', version: 'dev', deps: { ...d, hap } })
    const accs = a.bridge.bridgedAccessories
    expect(accs.map(x => x.displayName)).toEqual(['Grow light', 'Pump', 'Sensors', 'Upper camera', 'Lower camera'])
    expect(accs.map(x => x.UUID)).toEqual(b.bridge.bridgedAccessories.map(x => x.UUID))
    expect(a.bridge.UUID).toBe(b.bridge.UUID)
    const other = buildBridge({ identity: deriveIdentity({ resolved: 'hal-unit-id', value: 'gardyn-2' }, 0), name: 'Kitchen', version: 'dev', deps: { ...d, hap } })
    expect(other.bridge.UUID).not.toBe(a.bridge.UUID)
    const services = (i: number) => (accs[i] as hap.Accessory).services.map(s => s.UUID).filter(u => u !== hap.Service.AccessoryInformation.UUID)
    expect(services(0)).toEqual([hap.Service.Lightbulb.UUID])
    expect(services(1)).toEqual([hap.Service.Switch.UUID])
    expect(services(2)).toEqual([hap.Service.TemperatureSensor.UUID, hap.Service.HumiditySensor.UUID, hap.Service.Battery.UUID])
    for (const cam of [3, 4]) expect(services(cam)).toContain(hap.Service.CameraRTPStreamManagement.UUID)
    const info = a.bridge.getService(hap.Service.AccessoryInformation) as hap.Service
    expect(info.getCharacteristic(hap.Characteristic.SerialNumber).value).toBe(identity.username)
    // Home reads every bridged accessory's firmware on connect; they report core's, not hap-nodejs's 0.0.0.
    const v0 = buildBridge({ identity, name: 'Kitchen', version: 'v0.3.1', deps: { ...d, hap } })
    expect(v0.bridge.bridgedAccessories.map(x => x.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.FirmwareRevision).value)).toEqual(Array(5).fill('0.3.1'))
    for (const s of v0.stops) s()
    for (const s of [...a.stops, ...b.stops, ...other.stops]) s()
  })

  it('adds only the cameras hald reports', () => {
    const { deps: d } = deps()
    const snapshot = d.hal.snapshot.bind(d.hal)
    const system = snapshot().system
    if (!system) throw new Error('sim reports no system')
    const one = buildBridge({ identity, name: 'Kitchen', version: 'dev', deps: { ...d, hap, hal: { snapshot: () => ({ ...snapshot(), system: { ...system, caps: { ...system.caps, cameras: ['lower'] } } }) } } })
    expect(one.bridge.bridgedAccessories.map(x => x.displayName)).toEqual(['Grow light', 'Pump', 'Sensors', 'Lower camera'])
    const unknown = buildBridge({ identity, name: 'Kitchen', version: 'dev', deps: { ...d, hap, hal: { snapshot: () => ({ ...snapshot(), system: null }) } } })
    expect(unknown.bridge.bridgedAccessories).toHaveLength(5)
    for (const s of [...one.stops, ...unknown.stops]) s()
  })

  it('stops what it built when a builder throws', () => {
    const { deps: d, events } = deps()
    const listeners = vi.spyOn(events, 'subscribe')
    const unsub = vi.fn()
    listeners.mockReturnValueOnce(unsub).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => buildBridge({ identity, name: 'Kitchen', version: 'dev', deps: { ...d, hap } })).toThrow('boom')
    expect(unsub).toHaveBeenCalled()
  })

  it('cleans names HAP would reject, and versions it can\'t parse', () => {
    expect(hapName('Kitchen')).toBe('Kitchen')
    expect(hapName('  Jon\'s  tower #2! ')).toBe('Jon\'s tower 2')
    expect(hapName('🌱')).toBe('seedypod')
    expect(hapName('-Gardyn-')).toBe('Gardyn')
    expect(hapName('Jons\'')).toBe('Jons')
    expect(hapName('A')).toBe('seedypod')
    expect(firmware('v0.3.1-4-gabc')).toBe('0.3.1')
    expect(firmware('main@abc1234')).toBe('1234')
    expect(firmware('dev')).toBe('0.0.0')
  })
})

describe('publishBridge', () => {
  it('publishes with the identity and advertiser, and unpublishes (never destroy) on stop', async () => {
    const publish = vi.spyOn(hap.Bridge.prototype, 'publish').mockResolvedValue()
    vi.spyOn(hap.Bridge.prototype, 'setupURI').mockReturnValue('X-HM://TEST')
    const unpublish = vi.spyOn(hap.Bridge.prototype, 'unpublish').mockResolvedValue()
    const destroy = vi.spyOn(hap.Bridge.prototype, 'destroy').mockResolvedValue()
    const { deps: d, events } = deps()
    const subs = vi.spyOn(events, 'subscribe')
    const o = options(d, { bind: ['wlan0'], advertiser: 'avahi' })
    const b = await publishBridge(o)
    expect(publish).toHaveBeenCalledWith({ username: identity.username, pincode: identity.pincode, setupID: identity.setupId, port: 51827, category: 2, advertiser: 'avahi', bind: ['wlan0'] })
    expect(b.setupURI).toBe('X-HM://TEST')
    const bridge = publish.mock.contexts[0] as hap.Bridge
    bridge.emit('paired')
    bridge.emit('unpaired')
    expect(o.onPaired).toHaveBeenCalled()
    expect(o.onUnpaired).toHaveBeenCalled()
    const unsubs = subs.mock.results.map(r => r.value as () => boolean)
    await b.unpublish()
    expect(unpublish).toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
    expect(bridge.listenerCount('paired')).toBe(0)
    // Every accessory's event subscription was released.
    expect(unsubs.every(u => u() === false)).toBe(true)
  })

  it('a failed publish releases the accessories', async () => {
    vi.spyOn(hap.Bridge.prototype, 'publish').mockRejectedValue(new Error('EADDRINUSE'))
    const { deps: d, events } = deps()
    const subs = vi.spyOn(events, 'subscribe')
    await expect(publishBridge(options(d))).rejects.toThrow('EADDRINUSE')
    expect(subs.mock.results.map(r => (r.value as () => boolean)())).toEqual([false, false, false])
  })

  it('treats an mDNS failure after the HAP server closed as stopped, and rethrows otherwise', async () => {
    vi.spyOn(hap.Bridge.prototype, 'publish').mockResolvedValue()
    vi.spyOn(hap.Bridge.prototype, 'setupURI').mockReturnValue('X-HM://TEST')
    const { deps: d, log } = deps()
    const unpublish = vi.spyOn(hap.Bridge.prototype, 'unpublish').mockRejectedValue(new Error('advertiser destroy failed'))
    const b = await publishBridge(options(d))
    await expect(b.unpublish()).resolves.toBeUndefined()
    expect(log).toEqual(['homekit: bridged Grow light, Pump, Sensors, Upper camera, Lower camera', 'homekit: mDNS cleanup failed after stop: advertiser destroy failed'])

    unpublish.mockImplementation(async function (this: hap.Bridge) {
      (this as unknown as { _server: unknown })._server = {}
      throw new Error('server close failed')
    })
    const c = await publishBridge(options(d))
    await expect(c.unpublish()).rejects.toThrow('server close failed')
  })

  it('keeps one HAP storage path per process', async () => {
    const h = { HAPStorage: { setCustomStoragePath: vi.fn() } } as unknown as typeof hap
    initStorage(h, '/tmp/seedypod-homekit-bridge-test')
    initStorage(h, '/tmp/seedypod-homekit-bridge-test')
    expect(vi.mocked(h.HAPStorage.setCustomStoragePath).mock.calls.length).toBeLessThanOrEqual(1)
    expect(() => initStorage(h, '/elsewhere')).toThrow(/restart core/)
  })
})
