import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { CaptureService, MemorySink } from '../captures'

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
    hal.captureStill = async () => new Uint8Array(2048)
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
})
