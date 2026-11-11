import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { podvisionCodeReader } from '../nativeExecutor'
import { DARK_STILL, PodCodeService, podCodeViews, type CodeReader, type CodesOutput } from '../podCodes'
import { DEFAULT_REGIONS } from '../regions'

/** podvision's answer for a camera: these slots read, everything else on it unknown. */
function codes(read: Record<number, string>, o: Partial<CodesOutput> = {}): CodesOutput {
  return {
    width: 2592,
    height: 1944,
    brightness: 0.4,
    damaged: false,
    pods: Object.entries(read).map(([slot, code]) => ({ slot: Number(slot), code, confidence: 0.9, dots: [] })),
    ms: { decode: 1, read: 1 },
    ...o,
  }
}

function rig(reader: CodeReader | null, fail: Partial<Record<'upper' | 'lower', Error>> = {}) {
  const store = new MemoryStore(30)
  let t = 0
  const captures = {
    capturePodId: vi.fn(async (camera: 'upper' | 'lower') => {
      if (fail[camera]) throw fail[camera]
      return { still: { ts: `2026-11-11T21:0${t++}:00.000Z` }, bytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]) }
    }),
  }
  const log = vi.fn()
  return { store, captures, log, svc: new PodCodeService({ store, captures, reader, log }) }
}

describe('PodCodeService (#224)', () => {
  it('reads both cameras and keeps each pod\'s latest read, unknown ones too', async () => {
    const reader = vi.fn<CodeReader>(async (_bytes, regions) => (regions[1] ? codes({ 6: 'oo||', 9: null as never }) : codes({ 16: 'o|hh' })))
    const { store, svc } = rig(reader)
    expect(svc.available).toBe(true)
    const out = await svc.readAll()
    expect(out).toEqual([
      { camera: 'upper', ts: '2026-11-11T21:00:00.000Z', read: 1, error: null },
      { camera: 'lower', ts: '2026-11-11T21:01:00.000Z', read: 1, error: null },
    ])
    // Each camera's own boxes went to the reader.
    expect(reader.mock.calls[0]?.[1]).toEqual(DEFAULT_REGIONS.upper)
    expect(reader.mock.calls[1]?.[1]).toEqual(DEFAULT_REGIONS.lower)
    expect(store.podCodes.reads().map(r => [r.slot, r.camera, r.code])).toEqual([[6, 'upper', 'oo||'], [9, 'upper', null], [16, 'lower', 'o|hh']])
  })

  it('uses the owner\'s calibrated boxes', async () => {
    const reader = vi.fn<CodeReader>(async () => codes({}))
    const { store, svc } = rig(reader)
    const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    store.settings.update({ podRegions: { upper: { 6: box } } })
    await svc.readCamera('upper')
    expect(reader.mock.calls[0]?.[1][6]).toEqual(box)
    expect(reader.mock.calls[0]?.[1][1]).toEqual(DEFAULT_REGIONS.upper[1])
  })

  it('keeps the last reads when a still is dark, damaged or fails, and says why', async () => {
    let next = codes({ 6: 'oo||' })
    const { store, svc, log } = rig(async () => next, { lower: new Error('no good full-size frame: damaged frame') })
    await svc.readCamera('upper')
    next = codes({ 6: 'oooo' }, { brightness: DARK_STILL / 2 })
    await expect(svc.readCamera('upper')).rejects.toThrow(/too dark/)
    next = codes({}, { damaged: true })
    await expect(svc.readCamera('upper')).rejects.toThrow(/damaged/)
    expect(store.podCodes.reads().map(r => r.code)).toEqual(['oo||'])
    next = codes({ 6: 'oo||' })
    const out = await svc.readAll()
    expect(out[1]).toEqual({ camera: 'lower', ts: null, read: 0, error: 'no good full-size frame: damaged frame' })
    expect(log).toHaveBeenCalledWith('pod codes: no good full-size frame: damaged frame')
  })

  it('shares one run between callers', async () => {
    const reader = vi.fn<CodeReader>(async () => codes({}))
    const { svc, captures } = rig(reader)
    const [a, b] = await Promise.all([svc.readAll(), svc.readAll()])
    expect(a).toBe(b)
    expect(captures.capturePodId).toHaveBeenCalledTimes(2)
    await svc.readAll()
    expect(captures.capturePodId).toHaveBeenCalledTimes(4)
  })

  it('reads nothing without podvision', async () => {
    const { svc, captures } = rig(null)
    expect(svc.available).toBe(false)
    await expect(svc.readCamera('upper')).rejects.toThrow(/podvision isn't installed/)
    expect(captures.capturePodId).not.toHaveBeenCalled()
  })

  it('shows read pods with the confirmed plant, or the record\'s plant as the guess', async () => {
    const { store, svc } = rig(async () => codes({ 1: 'ooh|', 6: 'oo||', 8: null as never }))
    await svc.readCamera('upper')
    store.pods.update(6, { plant: 'Green Bok Choy' }, 't')
    store.pods.update(1, { plant: 'Basil' }, 't')
    expect(svc.confirm('ooh|', '  Chives ', 't').plant).toBe('Chives')
    expect(podCodeViews(store).map(v => [v.slot, v.code, v.confirmed, v.recorded])).toEqual([
      [1, 'ooh|', 'Chives', 'Basil'],
      [6, 'oo||', null, 'Green Bok Choy'],
    ])
  })
})

// The real binary, when it's built: `cargo build -p podvision` in hal/.
const built = [process.env.PODVISION_TEST_BIN, resolve(import.meta.dirname, '../../../hal/target/release/podvision'), resolve(import.meta.dirname, '../../../hal/target/debug/podvision')].find(p => p && existsSync(p))

describe.skipIf(!built)('podvision --codes itself', { timeout: 60_000 }, () => {
  it('reads pod 6 off its fixture crop', async () => {
    const bytes = readFileSync(resolve(import.meta.dirname, '../../../hal/crates/podvision/fixtures/dotcodes/upper-2026-11-11-pod6.jpg'))
    const out = await podvisionCodeReader(built as string)(bytes, { 6: { x: 53.6 / 432, y: -130 / 314, w: 326.3 / 432, h: 326.4 / 314 } })
    expect(out.pods).toMatchObject([{ slot: 6, code: 'oo||' }])
  })
})
