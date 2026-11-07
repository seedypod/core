import { describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { CaptureService, isWholeJpeg, MemorySink } from '../captures'

/** A frame with both markers, as hald sends. */
function frame(len = 2048) {
  const b = new Uint8Array(len)
  b.set([0xFF, 0xD8])
  b.set([0xFF, 0xD9], len - 2)
  return b
}

/** A service over a HAL whose cameras give what `still` says. */
function rig(still: (camera: 'upper' | 'lower') => Uint8Array | Error) {
  const store = new MemoryStore()
  const hal = new SimHal({ tickMs: 0 })
  hal.captureStill = async (camera) => {
    const got = still(camera)
    if (got instanceof Error) throw got
    return got
  }
  const enqueued: string[] = []
  const analysis = { enqueue: (c: { id: string }) => void enqueued.push(c.id), removeArtifacts: async () => undefined }
  const svc = new CaptureService({ hal, store, sink: new MemorySink(), minBytes: 1024, analysis })
  const detail = () => store.alerts.list({ activeOnly: true }).find(a => a.kind === 'camera_missing')?.detail
  return { store, svc, enqueued, detail }
}

describe('isWholeJpeg', () => {
  it('wants both markers', () => {
    expect(isWholeJpeg(frame())).toBe(true)
    expect(isWholeJpeg(frame().subarray(0, 2000))).toBe(false)
    expect(isWholeJpeg(frame().subarray(2))).toBe(false)
    expect(isWholeJpeg(new Uint8Array(2048))).toBe(false)
    expect(isWholeJpeg(new Uint8Array())).toBe(false)
  })
})

describe('CaptureService', () => {
  it('rejects implausibly small images and raises camera_missing', async () => {
    const store = new MemoryStore()
    const hal = new SimHal({ tickMs: 0 }) // returns a 4-byte stub
    const svc = new CaptureService({ hal, store, sink: new MemorySink(), minBytes: 1024 })
    await expect(svc.capture('upper')).rejects.toThrow(/no usable image/)
    expect(store.alerts.list({ activeOnly: true })[0]?.kind).toBe('camera_missing')
  })

  it('stores, serves and prunes captures', async () => {
    const store = new MemoryStore()
    const hal = new SimHal({ tickMs: 0 })
    hal.captureStill = async () => frame()
    let t = 0
    const svc = new CaptureService({ hal, store, sink: new MemorySink(), minBytes: 1024, keep: 2, now: () => new Date(t) })
    for (let i = 0; i < 3; i++) {
      t = i * 1000
      await svc.capture('lower')
    }
    expect(store.captures.list('lower')).toHaveLength(2)
    const latest = store.captures.list('lower')[0]
    const got = await svc.bytes(latest?.id ?? '')
    expect(got?.bytes.byteLength).toBe(2048)
    expect(await svc.bytes('nope')).toBeNull()
  })

  it('stores and analyses nothing from a truncated frame, and says so', async () => {
    const { store, svc, enqueued, detail } = rig(() => frame().subarray(0, 1500))
    await expect(svc.capture('upper')).rejects.toThrow(/no usable image/)
    expect(store.captures.list('upper')).toHaveLength(0)
    expect(enqueued).toEqual([])
    expect(detail()).toBe('upper camera sent an incomplete JPEG')
  })

  it('stores and analyses nothing when hald refuses the frame, and passes on why', async () => {
    const { store, svc, enqueued, detail } = rig(() => new Error('no good frame in 3 attempts: damaged frame'))
    await expect(svc.capture('upper')).rejects.toThrow('upper camera failed: no good frame')
    expect(store.captures.list('upper')).toHaveLength(0)
    expect(enqueued).toEqual([])
    expect(detail()).toBe('upper camera failed: no good frame in 3 attempts: damaged frame')
  })

  it('keeps taking the good camera, and its stills don\'t clear the bad camera\'s alert', async () => {
    const { store, svc, enqueued, detail } = rig(c => (c === 'upper' ? new Error('torn') : frame()))
    await svc.captureAll()
    expect(store.captures.list('lower')).toHaveLength(1)
    expect(store.captures.list('upper')).toHaveLength(0)
    expect(enqueued).toHaveLength(1)
    expect(detail()).toBe('upper camera failed: torn')
    await svc.capture('lower')
    expect(detail()).toBe('upper camera failed: torn')
  })

  it('leaves the alert alone while one camera stays failing, as a unit with a dead link can for months', async () => {
    const { store, svc, enqueued, detail } = rig(c => (c === 'upper' ? new Error('no good frame: damaged frame') : frame()))
    await svc.captureAll()
    const raise = vi.spyOn(store.alerts, 'raise')
    const clear = vi.spyOn(store.alerts, 'clear')
    for (let i = 0; i < 5; i++) await svc.captureAll()
    expect(raise).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(detail()).toBe('upper camera failed: no good frame: damaged frame')
    // The good camera keeps being stored and analysed all the while.
    expect(store.captures.list('lower').length).toBeGreaterThan(0)
    expect(enqueued).toHaveLength(6)
  })

  it('raises a persistent capture failure again after hald clears the shared alert', async () => {
    const { store, svc, detail } = rig(c => (c === 'upper' ? new Error('torn') : frame()))
    await svc.captureAll()
    store.alerts.clear('camera_missing', new Date().toISOString())
    expect(detail()).toBeUndefined()
    await svc.captureAll()
    expect(detail()).toBe('upper camera failed: torn')
  })

  it('feeds what hald says about the link into the connection notice, on good stills and refused ones', async () => {
    const store = new MemoryStore()
    let damaged = 2
    let fails = false
    const hal = Object.assign(new SimHal({ tickMs: 0 }), { damagedFrames: () => damaged, hubBoots: () => ({ missing: 8, total: 10 }) })
    hal.captureStill = async () => {
      if (fails) throw new Error('no good frame: damaged frame')
      return frame()
    }
    const svc = new CaptureService({ hal, store, sink: new MemorySink(), minBytes: 1024 })
    const kinds = () => store.alerts.list({ activeOnly: true }).map(a => a.kind).sort()
    await svc.capture('upper')
    expect(kinds()).toEqual(['camera_hub_flaky'])
    fails = true
    await expect(svc.capture('upper')).rejects.toThrow('damaged frame')
    expect(kinds()).toEqual(['camera_hub_flaky', 'camera_link_upper', 'camera_missing'])
    fails = false
    damaged = 0
    await svc.capture('upper')
    expect(kinds()).toEqual(['camera_hub_flaky', 'camera_link_upper'])
  })

  it('names both cameras when both fail, and clears only once both have recovered', async () => {
    let bad: Array<'upper' | 'lower'> = ['upper', 'lower']
    const { svc, detail } = rig(c => (bad.includes(c) ? new Error('torn') : frame()))
    await svc.captureAll()
    expect(detail()).toBe('upper camera failed: torn; lower camera failed: torn')
    bad = ['lower']
    await svc.capture('upper')
    expect(detail()).toBe('lower camera failed: torn')
    bad = []
    await svc.capture('lower')
    expect(detail()).toBeUndefined()
  })
})
