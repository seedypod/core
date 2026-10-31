import { describe, expect, it, vi } from 'vitest'
import { MemorySink } from '../../camera/captures'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import type { Capture } from '../../store/types'
import type { Executor } from '../execute'
import { inlineExecutor } from '../execute'
import { AnalysisService, artifactKey } from '../service'
import { jpeg } from './fixtures'

const cap = (id: string, camera: 'upper' | 'lower' = 'upper', ts = '2026-01-01T00:00:00Z'): Capture => ({ id, camera, ts, path: `${id}.jpg`, bytes: 1 })

function setup(executor: Executor = inlineExecutor) {
  const store = new MemoryStore()
  const sink = new MemorySink()
  const events = createEventBus()
  const seen: string[] = []
  events.subscribe(e => e.kind === 'mutation' && seen.push(e.path))
  return { store, sink, events, seen, svc: new AnalysisService({ store, sink, events, executor }) }
}

describe('AnalysisService', () => {
  it('scores a capture with every on-device analyser and announces it', async () => {
    const { store, svc, seen } = setup()
    svc.enqueue(cap('a'), jpeg(120, 100, true))
    await svc.idle()
    const rows = store.analyses.forCapture('a')
    expect(new Set(rows.map(r => r.analyzer))).toEqual(new Set(['green-threshold', 'exg-otsu']))
    expect(rows.every(r => r.source === 'device' && r.camera === 'upper' && r.ts === '2026-01-01T00:00:00Z')).toBe(true)
    expect(seen).toContain('analyses')
    expect(svc.status()).toMatchObject({ running: null, waiting: [], dropped: 0, failed: 0, backfill: null })
  })

  it('keeps one waiting still per camera, replacing older ones that never started', async () => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const started: string[] = []
    const { store, svc } = setup(async (job) => {
      await gate
      started.push(job.camera)
      return inlineExecutor(job)
    })
    svc.enqueue(cap('u1'), jpeg(30, 30, true))
    svc.enqueue(cap('u2'), jpeg(30, 30, true))
    svc.enqueue(cap('l1', 'lower'), jpeg(30, 30, true))
    svc.enqueue(cap('u3'), jpeg(30, 30, true))
    expect(svc.status().dropped).toBe(2)
    release()
    await svc.idle()
    expect(store.analyses.forCapture('u1')).toEqual([])
    expect(store.analyses.forCapture('u2')).toEqual([])
    expect(store.analyses.forCapture('u3').length).toBeGreaterThan(0)
    expect(store.analyses.forCapture('l1').length).toBeGreaterThan(0)
  })

  it('counts failures and carries on', async () => {
    const { store, svc } = setup(async () => {
      throw new Error('worker died')
    })
    svc.enqueue(cap('a'), jpeg(30, 30, true))
    await svc.idle()
    expect(svc.status().failed).toBe(1)
    expect(store.analyses.forCapture('a')).toEqual([])
    // Non-JPEG bytes are simply not scored.
    const ok = setup()
    ok.svc.enqueue(cap('svg'), new TextEncoder().encode('<svg/>'))
    await ok.svc.idle()
    expect(ok.svc.status().failed).toBe(0)
  })

  it('stores artifacts in the sink when enabled and removes them on prune', async () => {
    const { store, sink, svc } = setup()
    store.settings.update({ analysisArtifacts: true })
    svc.enqueue(cap('a'), jpeg(60, 40, true))
    await svc.idle()
    const key = artifactKey('a', 'exg-otsu', 1, 'mask.pbm')
    const rows = store.analyses.forCapture('a')
    expect(rows.filter(r => r.analyzer === 'exg-otsu').every(r => r.artifact === key)).toBe(true)
    expect(rows.filter(r => r.analyzer === 'green-threshold').every(r => r.artifact === null)).toBe(true)
    expect(await sink.get(key)).not.toBeNull()
    await svc.removeArtifacts('a')
    expect(await sink.get(key)).toBeNull()
  })

  it('re-runs one analyser over stored captures in the background', async () => {
    const { store, sink, svc } = setup()
    for (const id of ['a', 'b', 'c']) {
      const c = cap(id, 'upper', `2026-01-0${id.charCodeAt(0) - 96}T00:00:00Z`)
      store.captures.add(c)
      await sink.put(c.path, jpeg(40, 40, true))
    }
    store.captures.add(cap('gone'))
    expect(svc.rerun('exg-otsu')).toBe(4)
    expect(svc.status().backfill).toMatchObject({ analyzer: 'exg-otsu', total: 4 })
    expect(() => svc.rerun('exg-otsu')).toThrow(/already re-running/)
    await svc.idle()
    expect(svc.status().backfill).toBeNull()
    for (const id of ['a', 'b', 'c']) expect(store.analyses.forCapture(id).map(r => r.analyzer)).toContain('exg-otsu')
    expect(store.analyses.forCapture('a').some(r => r.analyzer === 'green-threshold')).toBe(false)
    expect(() => svc.rerun('leaf-unet')).toThrow(/not an on-device analyser/)
  })

  it('lists device analysers, older versions and remote ones with their totals', async () => {
    const { store, svc } = setup()
    svc.enqueue(cap('a'), jpeg(30, 30, true))
    await svc.idle()
    const base = { captureId: 'a', ts: '2026-01-01T00:00:00Z', camera: 'upper' as const, slot: 1, metric: 'green_fraction', value: 0.3, detail: null, artifact: null }
    store.analyses.add([
      { ...base, analyzer: 'leaf-unet', version: 3, source: 'remote' },
      { ...base, analyzer: 'exg-otsu', version: 0, source: 'device' },
    ])
    store.settings.update({ primaryAnalyzer: 'leaf-unet' })
    const list = svc.list()
    expect(list.map(a => `${a.id}@${a.version}:${a.source}`)).toEqual(['green-threshold@1:device', 'exg-otsu@1:device', 'exg-otsu@0:device', 'leaf-unet@3:remote'])
    expect(list.find(a => a.id === 'green-threshold')).toMatchObject({ rows: 15, captures: 1, primary: false })
    expect(list.find(a => a.id === 'leaf-unet')).toMatchObject({ primary: true, label: 'leaf-unet', runsOn: ['remote'], rows: 1 })
    expect(list.find(a => a.version === 0)?.description).toMatch(/Older version/)
    expect(list.filter(a => a.primary)).toHaveLength(1)
  })

  it('never makes a capture wait for analysis', async () => {
    const slow = vi.fn(() => new Promise<null>(() => {}))
    const { svc } = setup(slow)
    svc.enqueue(cap('a'), jpeg(30, 30, true))
    await Promise.resolve()
    expect(svc.status().running).toBe('a')
  })
})
