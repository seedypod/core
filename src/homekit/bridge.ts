/**
 * The HAP bridge: one HomeKit device that carries the grow light, the pump
 * and the sensors. Loaded only when HomeKit is switched on (service.ts imports
 * it dynamically), so hap-nodejs costs nothing on a unit that doesn't use it.
 */
import type { Bridge } from 'hap-nodejs'
import type { Identity } from './identity'
import { buildCamera } from './accessories/camera'
import type { AccessoryDeps, BuiltAccessory, Camera, Hap } from './accessories/common'
import { buildLight } from './accessories/light'
import { buildPump } from './accessories/pump'
import { buildSensors } from './accessories/sensors'

// hap-nodejs declares Categories and MDNSAdvertiser as `const enum`s, which isolatedModules can't read.
const CATEGORY_BRIDGE = 2
export const ADVERTISERS = ['ciao', 'avahi', 'bonjour-hap', 'resolved'] as const
export type Advertiser = typeof ADVERTISERS[number]

export interface BridgeOptions {
  identity: Identity
  /** HAP's own files (pairings, accessory ids) go here, next to identity.json. */
  dir: string
  /** Everything the accessories need but hap-nodejs, which this module loads. */
  deps: Omit<AccessoryDeps, 'hap'>
  /** Shown in Home's Add Accessory sheet. */
  name: string
  port: number
  advertiser: Advertiser
  /** Interface names or addresses; unset = all. */
  bind?: string[]
  version: string
  onPaired(): void
  onUnpaired(): void
}

export interface PublishedBridge {
  setupURI: string
  unpublish(): Promise<void>
}

let storageDir: string | null = null

/** hap-nodejs keeps one storage path per process and throws on a second set. */
export function initStorage(hap: Hap, dir: string): void {
  if (storageDir === dir) return
  if (storageDir !== null) throw new Error(`HomeKit storage is already at ${storageDir}; restart core to move it to ${dir}`)
  hap.HAPStorage.setCustomStoragePath(dir)
  storageDir = dir
}

/** HAP names: letters, digits, spaces and apostrophes, at least two long, starting and ending with a letter or digit. */
export function hapName(name: string, fallback = 'seedypod'): string {
  const clean = name.replace(/[^\p{L}\p{N} ']+/gu, ' ').replace(/\s+/g, ' ').slice(0, 64).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return clean.length >= 2 ? clean : fallback
}

const ACCESSORIES: ReadonlyArray<{ id: string, name: string, build: (d: AccessoryDeps) => BuiltAccessory }> = [
  { id: 'light', name: 'Grow light', build: buildLight },
  { id: 'pump', name: 'Pump', build: buildPump },
  { id: 'sensors', name: 'Sensors', build: buildSensors },
]

const CAMERA_NAMES: Record<Camera, string> = { upper: 'Upper camera', lower: 'Lower camera' }

/** The fixed accessories, then one per camera hald reports (both until it has reported). */
function accessoriesFor(d: AccessoryDeps): ReadonlyArray<{ id: string, name: string, build: (d: AccessoryDeps) => BuiltAccessory }> {
  const cameras = d.hal.snapshot().system?.caps.cameras ?? ['upper', 'lower']
  return [...ACCESSORIES, ...cameras.map(cam => ({ id: `camera_${cam}`, name: CAMERA_NAMES[cam], build: (dd: AccessoryDeps) => buildCamera(cam, dd) }))]
}

/** The accessory tree. UUIDs come from the username, so they stay put across restarts. */
export function buildBridge(o: Pick<BridgeOptions, 'identity' | 'name' | 'version'> & { deps: AccessoryDeps }): { bridge: Bridge, stops: Array<() => void> } {
  const { Accessory, Bridge, Characteristic, Service, uuid } = o.deps.hap
  const { username } = o.identity
  const bridge = new Bridge(o.name, uuid.generate(`seedypod:${username}`))
  bridge.getService(Service.AccessoryInformation)
    ?.setCharacteristic(Characteristic.Manufacturer, 'seedypod')
    .setCharacteristic(Characteristic.Model, 'seedypod core')
    .setCharacteristic(Characteristic.SerialNumber, username)
    .setCharacteristic(Characteristic.FirmwareRevision, firmware(o.version))
  const stops: Array<() => void> = []
  try {
    for (const a of accessoriesFor(o.deps)) {
      const built = a.build(o.deps)
      stops.push(built.stop)
      const acc = new Accessory(a.name, uuid.generate(`seedypod:${username}:${a.id}`))
      acc.getService(Service.AccessoryInformation)
        ?.setCharacteristic(Characteristic.Manufacturer, 'seedypod')
        .setCharacteristic(Characteristic.Model, a.name)
        .setCharacteristic(Characteristic.SerialNumber, `${username}-${a.id}`)
      for (const s of built.services) acc.addService(s)
      for (const c of built.controllers ?? []) acc.configureController(c)
      bridge.addBridgedAccessory(acc)
    }
  }
  catch (e) {
    for (const stop of stops) stop()
    throw e
  }
  return { bridge, stops }
}

/** HAP wants `x[.y[.z]]`; builds report a git describe or 'dev'. */
export function firmware(version: string): string {
  return version.match(/\d+(?:\.\d+){0,2}/)?.[0] ?? '0.0.0'
}

export async function publishBridge(o: BridgeOptions): Promise<PublishedBridge> {
  const hap = await import('hap-nodejs')
  initStorage(hap, o.dir)
  const { bridge, stops } = buildBridge({ ...o, deps: { ...o.deps, hap } })
  bridge.on('paired', o.onPaired)
  bridge.on('unpaired', o.onUnpaired)
  const stopAll = () => {
    for (const stop of stops) stop()
    bridge.removeAllListeners('paired')
    bridge.removeAllListeners('unpaired')
  }
  try {
    await bridge.publish({
      username: o.identity.username,
      pincode: o.identity.pincode,
      setupID: o.identity.setupId,
      port: o.port,
      category: CATEGORY_BRIDGE,
      advertiser: o.advertiser as never,
      bind: o.bind,
    })
  }
  catch (e) {
    stopAll()
    throw e
  }
  // Home puts accessories that appear after pairing in the bridge's own room, so name what's there.
  o.deps.log(`homekit: bridged ${bridge.bridgedAccessories.map(a => a.displayName).join(', ')}`)
  return {
    setupURI: bridge.setupURI(),
    async unpublish() {
      stopAll()
      // unpublish(), never destroy(): destroy() deletes the pairing keys and accessory ids,
      // so every restart would need a re-pair (sleepypod PR #718).
      try {
        await bridge.unpublish()
      }
      catch (e) {
        // hap-nodejs closes the HAP server before tearing down mDNS; if only the
        // advertiser failed, the bridge is stopped and a new publish can proceed.
        if ((bridge as unknown as { _server?: unknown })._server) throw e
        o.deps.log(`homekit: mDNS cleanup failed after stop: ${(e as Error).message}`)
      }
    },
  }
}
