/**
 * A snapshot request as HAP's server hands it over: `POST /resource`, routed
 * by the bridge on the camera accessory's aid, answered from the stored still.
 */
import { createRequire } from 'node:module'
import * as hap from 'hap-nodejs'
import { afterEach, describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import type { AccessoryDeps } from '../accessories/common'
import { buildBridge, logResourceRequests } from '../bridge'
import { deriveIdentity } from '../identity'

interface Cache { getAID(uuid: string): number }
const { IdentifierCache } = createRequire(import.meta.url)('hap-nodejs/dist/lib/model/IdentifierCache') as { IdentifierCache: new (username: string) => Cache }

const identity = deriveIdentity({ resolved: 'hal-unit-id', value: 'gardyn-1a2b3c4d' }, 0)
const stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

interface ResourceRequest { 'resource-type': 'image', 'image-width': number, 'image-height': number, 'aid'?: number, 'reason'?: number }
interface Answer { error?: { httpCode: number, status: number }, image?: Buffer }

/** The bridge's resource handler, which hap-nodejs's server calls for `POST /resource`. */
function request(bridge: hap.Bridge, body: ResourceRequest): Promise<Answer> {
  const handle = (bridge as unknown as { handleResource(d: ResourceRequest, cb: (e: Answer['error'], b?: Buffer) => void): void }).handleResource.bind(bridge)
  return new Promise(resolve => handle(body, (error, image) => resolve({ error, image })))
}

async function setup() {
  const hal = new SimHal({ tickMs: 0 })
  const events = createEventBus()
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test', captureMinBytes: 1 })
  stops.push(() => void core.stop())
  const caller = createCallerFactory(appRouter)(core.ctx)
  const log: string[] = []
  const deps: AccessoryDeps = { hap, api: caller, hal, events, stills: core.ctx.captures, log: m => log.push(m) }
  const { bridge, stops: off } = buildBridge({ identity, name: 'Gardyn', version: 'test', deps })
  stops.push(...off)
  // What publish does before the server starts: aid 1 for the bridge, 2+ for what it bridges.
  ;(bridge as unknown as { _assignIDs(c: Cache): void })._assignIDs(new IdentifierCache(identity.username))
  logResourceRequests(bridge, m => log.push(m))
  const camera = (name: string) => bridge.bridgedAccessories.find(a => a.displayName === name) as hap.Accessory
  return { bridge, camera, caller, core, log }
}

describe('a bridged camera over HAP\'s resource request', () => {
  it('each camera answers its own aid with its newest stored still', async () => {
    const { bridge, camera, caller, core, log } = await setup()
    const upper = await caller.camera.capture({ camera: 'upper' })
    const lower = await caller.camera.capture({ camera: 'lower' })
    for (const [name, taken] of [['Upper camera', upper], ['Lower camera', lower]] as const) {
      const acc = camera(name)
      expect(acc.aid).toBeGreaterThan(1)
      const got = await request(bridge, { 'resource-type': 'image', 'image-width': 640, 'image-height': 480, 'aid': acc.aid as number, 'reason': 0 })
      expect(got.error).toBeUndefined()
      const stored = await core.ctx.captures.bytes(taken.id)
      expect(Buffer.compare(got.image as Buffer, Buffer.from(stored?.bytes ?? []))).toBe(0)
    }
    expect(log).toEqual([
      expect.stringMatching(/^homekit: upper camera: snapshot 640x480 served \d+ bytes in \d+ ms$/),
      expect.stringMatching(/^homekit: image request for Upper camera, 640x480, reason 0: \d+ bytes in \d+ ms$/),
      expect.stringMatching(/^homekit: lower camera: snapshot 640x480 served \d+ bytes in \d+ ms$/),
      expect.stringMatching(/^homekit: image request for Lower camera, 640x480, reason 0: \d+ bytes in \d+ ms$/),
    ])
  })

  it('while Home has a camera\'s streaming off, hap-nodejs refuses its snapshots, and both show in the log', async () => {
    const { bridge, camera, caller, log } = await setup()
    await caller.camera.capture({ camera: 'upper' })
    const acc = camera('Upper camera')
    const streams = acc.services.filter(sv => sv.UUID === hap.Service.CameraRTPStreamManagement.UUID).map(sv => sv.getCharacteristic(hap.Characteristic.Active))
    expect(streams).toHaveLength(2)
    // Home writing 1 over hap-nodejs's initial `true` is no switch.
    await streams[0]?.handleSetRequest(1)
    expect(log).toEqual([])
    // One stream off still serves; all off is what hap-nodejs refuses.
    await streams[0]?.handleSetRequest(0)
    expect(log).toEqual([])
    await streams[1]?.handleSetRequest(0)
    const got = await request(bridge, { 'resource-type': 'image', 'image-width': 640, 'image-height': 360, 'aid': acc.aid as number })
    expect(got.error).toEqual({ httpCode: 207, status: -70412 })
    expect(log).toEqual([
      'homekit: Upper camera: Home turned streaming off, so its snapshots are refused',
      expect.stringMatching(/^homekit: image request for Upper camera, 640x360, reason none: HTTP 207, status -70412 in \d+ ms$/),
    ])
    await streams[1]?.handleSetRequest(1)
    expect(log.at(-1)).toBe('homekit: Upper camera: Home turned streaming on')
    expect((await request(bridge, { 'resource-type': 'image', 'image-width': 640, 'image-height': 360, 'aid': acc.aid as number })).error).toBeUndefined()
  })

  it('a camera with nothing stored says so in the log, and HAP gets a status, not a hang', async () => {
    const { bridge, camera, core, log } = await setup()
    core.ctx.store.settings.update({ captureIntervalMin: 0 })
    const acc = camera('Upper camera')
    const sim = core.ctx.hal as SimHal
    sim.captureStill = async () => new Uint8Array(0)
    const got = await request(bridge, { 'resource-type': 'image', 'image-width': 320, 'image-height': 240, 'aid': acc.aid as number })
    expect(got.error).toEqual({ httpCode: 207, status: -70409 })
    expect(log).toEqual([
      expect.stringMatching(/^homekit: upper camera: snapshot 320x240 found no stored still \(\d+ ms\)$/),
      expect.stringMatching(/^homekit: image request for Upper camera, 320x240, reason none: HTTP 207, status -70409 in \d+ ms$/),
    ])
  })

  it('an aid that is no camera is a 404, as HAP wants', async () => {
    const { bridge, log } = await setup()
    const got = await request(bridge, { 'resource-type': 'image', 'image-width': 640, 'image-height': 480, 'aid': 999 })
    expect(got.error).toEqual({ httpCode: 404, status: -70409 })
    // Home asks again every ~10 s; the same answer isn't logged twice.
    await request(bridge, { 'resource-type': 'image', 'image-width': 640, 'image-height': 480, 'aid': 999 })
    expect(log).toEqual([expect.stringMatching(/^homekit: image request for aid 999, 640x480, reason none: HTTP 404, status -70409 in \d+ ms$/)])
    // No aid means the published accessory itself, which is the bridge and no camera.
    expect((await request(bridge, { 'resource-type': 'image', 'image-width': 640, 'image-height': 480 })).error).toEqual({ httpCode: 404, status: -70409 })
    expect(log.at(-1)).toMatch(/^homekit: image request for the bridge, 640x480, reason none: HTTP 404/)
  })
})
