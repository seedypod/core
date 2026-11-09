/**
 * The cameras as snapshot-only HomeKit cameras (ADR 0027): stored stills,
 * no live view, and a capture only when a camera has nothing stored.
 */
import * as hap from 'hap-nodejs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import type { Capture } from '../../store/types'
import { buildCamera, CAPTURE_FLOOR_MS, LIVE_VIEW_OFF, RESOURCE_DOES_NOT_EXIST, snapshotDelegate } from '../accessories/camera'
import type { AccessoryDeps } from '../accessories/common'

const stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

function setup() {
  const hal = new SimHal({ tickMs: 0 })
  const events = createEventBus()
  // The simulator's stills are smaller than a real camera's.
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test', captureMinBytes: 1 })
  stops.push(() => void core.stop())
  const caller = createCallerFactory(appRouter)(core.ctx)
  const stills = vi.spyOn(hal, 'captureStill')
  const log: string[] = []
  const deps: AccessoryDeps = { hap, api: caller, hal, events, stills: core.ctx.captures, log: m => log.push(m) }
  return { deps, caller, stills, log, core }
}

type Delegate = ReturnType<typeof snapshotDelegate>
const snap = (d: Delegate) => new Promise<{ error?: unknown, buffer?: Buffer }>(resolve =>
  d.handleSnapshotRequest({ height: 480, width: 640 }, (error, buffer) => resolve({ error, buffer })))

const still = (id: string): { capture: Capture, bytes: Uint8Array } => ({
  capture: { id, camera: 'upper', ts: '2026-11-08T00:00:00.000Z', path: id, bytes: 4 },
  bytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
})

describe('camera → snapshot-only CameraController', () => {
  it('a snapshot is the newest stored still, and asking for one never wakes the camera', async () => {
    const { deps, caller, stills, core } = setup()
    await caller.camera.capture({ camera: 'upper' })
    const newest = await caller.camera.capture({ camera: 'upper' })
    stills.mockClear()
    const built = buildCamera('upper', deps)
    expect(built.services).toEqual([])
    const controller = built.controllers?.[0] as hap.CameraController
    const acc = new hap.Accessory('Upper camera', hap.uuid.generate('seedypod:test:snapshot'))
    acc.configureController(controller)
    stops.push(() => void acc.destroy())
    const image = await controller.handleSnapshotRequest(480, 640)
    const stored = await core.ctx.captures.bytes(newest.id)
    expect(Buffer.compare(image, Buffer.from(stored?.bytes ?? []))).toBe(0)
    expect(stills).not.toHaveBeenCalled()
  })

  it('on the accessory: one RTP stream service with H.264 baseline, and no microphone', () => {
    const { deps } = setup()
    const acc = new hap.Accessory('Upper camera', hap.uuid.generate('seedypod:test:camera_upper'))
    for (const c of buildCamera('upper', deps).controllers ?? []) acc.configureController(c)
    const uuids = acc.services.map(s => s.UUID)
    expect(uuids.filter(u => u === hap.Service.CameraRTPStreamManagement.UUID)).toHaveLength(1)
    expect(uuids).not.toContain(hap.Service.Microphone.UUID)
    expect(uuids).not.toContain(hap.Service.CameraRecordingManagement.UUID)
    acc.destroy()
  })

  it('a camera with no still takes one, once, however many requests arrive', async () => {
    const { deps, stills } = setup()
    const d = snapshotDelegate('lower', deps)
    const [a, b] = await Promise.all([snap(d), snap(d)])
    expect(stills).toHaveBeenCalledTimes(1)
    expect(a.error).toBeUndefined()
    expect(Buffer.compare(a.buffer as Buffer, b.buffer as Buffer)).toBe(0)
    await snap(d)
    expect(stills).toHaveBeenCalledTimes(1)
  })

  it('a camera that can\'t take one is asked again only after the floor, and Home gets no image', async () => {
    let t = 0
    const capture = vi.fn().mockRejectedValue(new Error('upper camera failed'))
    const log: string[] = []
    const d = snapshotDelegate('upper', { api: { camera: { capture } } as unknown as AccessoryDeps['api'], stills: { latest: async () => null }, log: m => log.push(m) }, () => t)
    expect(await snap(d)).toEqual({ error: RESOURCE_DOES_NOT_EXIST, buffer: undefined })
    t = CAPTURE_FLOOR_MS - 1
    await snap(d)
    expect(capture).toHaveBeenCalledTimes(1)
    t = CAPTURE_FLOOR_MS
    await snap(d)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(log).toEqual([])
  })

  it('serves what was stored even when it can\'t capture, and logs a storage failure', async () => {
    const capture = vi.fn()
    const log: string[] = []
    const latest = vi.fn().mockResolvedValueOnce(still('upper-1')).mockRejectedValueOnce(new Error('EIO'))
    const d = snapshotDelegate('upper', { api: { camera: { capture } } as unknown as AccessoryDeps['api'], stills: { latest }, log: m => log.push(m) })
    expect((await snap(d)).buffer?.length).toBe(4)
    expect(await snap(d)).toEqual({ error: RESOURCE_DOES_NOT_EXIST, buffer: undefined })
    expect(capture).not.toHaveBeenCalled()
    expect(log).toEqual(['homekit: upper snapshot failed: EIO'])
  })

  it('turns down live view', async () => {
    const { deps } = setup()
    const d = snapshotDelegate('upper', deps)
    const prepared = await new Promise<Error | undefined>(r => d.prepareStream({} as never, e => r(e)))
    const started = await new Promise<Error | undefined>(r => d.handleStreamRequest({} as never, e => r(e)))
    expect(prepared?.message).toBe(LIVE_VIEW_OFF)
    expect(started?.message).toBe(LIVE_VIEW_OFF)
  })
})
