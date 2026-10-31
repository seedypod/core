import { describe, expect, it } from 'vitest'
import { createApp } from '../../../server/app'
import { MemorySink } from '../../camera/captures'
import { MirroredSink, S3Sink } from '../../camera/mirrorSink'
import { SimHal } from '../../hardware/sim'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'

function unit(opts: { token?: string, apiKey?: string } = {}) {
  const store = new MemoryStore()
  store.settings.update({ analysisIngestToken: opts.token ?? 'tok', apiKey: opts.apiKey ?? '' })
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test' })
  store.captures.add({ id: 'upper-1', camera: 'upper', ts: '2026-10-30T00:00:00Z', path: 'upper-1.jpg', bytes: 1 })
  const { app } = createApp({ ctx: core.ctx })
  // Requests from a remote worker: not loopback, so the API-key guard applies to everything but ingest.
  const post = (body: unknown, token?: string) => app.request('/api/analyses/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.9', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { store, ctx: core.ctx, app, post }
}

const batch = (o: Record<string, unknown> = {}) => ({ analyzer: 'leaf-unet', version: 2, results: [{ captureId: 'upper-1', slot: 3, metric: 'green_fraction', value: 0.42, detail: { conf: 0.9 } }], ...o })

describe('POST /api/analyses/results', () => {
  it('stores results under the remote analyser next to the on-device ones', async () => {
    const { post, store, ctx } = unit()
    const r = await post(batch({ results: [
      { captureId: 'upper-1', slot: 3, metric: 'green_fraction', value: 0.42, detail: { conf: 0.9 } },
      { captureId: 'pruned', slot: 20, metric: 'leaf_count', value: 7, ts: '2026-09-01T00:00:00Z', camera: 'lower' },
      { captureId: 'unknown', slot: 1, metric: 'green_fraction', value: 0.1 },
    ] }), 'tok')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ stored: 2, skipped: ['unknown'] })
    expect(store.analyses.forCapture('upper-1')).toMatchObject([{ analyzer: 'leaf-unet', version: 2, source: 'remote', camera: 'upper', ts: '2026-10-30T00:00:00Z', detail: { conf: 0.9 } }])
    expect(store.analyses.forCapture('pruned')).toMatchObject([{ camera: 'lower', metric: 'leaf_count', value: 7 }])
    expect(ctx.analysis.list().find(a => a.id === 'leaf-unet')).toMatchObject({ source: 'remote', captures: 2 })
    // Posting again replaces rather than duplicates.
    await post(batch(), 'tok')
    expect(store.analyses.forCapture('upper-1')).toHaveLength(1)
  })

  it('is off without a token and refuses wrong tokens, bad batches and on-device ids', async () => {
    expect((await unit({ token: '' }).post(batch(), 'x')).status).toBe(404)
    const { post } = unit()
    expect((await post(batch())).status).toBe(401)
    expect((await post(batch(), 'nope')).status).toBe(401)
    expect((await post(batch({ analyzer: 'Bad Id' }), 'tok')).status).toBe(400)
    expect((await post(batch({ results: [] }), 'tok')).status).toBe(400)
    expect((await post({ analyzer: 'x' }, 'tok')).status).toBe(400)
    const dev = await post(batch({ analyzer: 'exg-otsu' }), 'tok')
    expect(dev.status).toBe(409)
    expect((await dev.json() as { error: string }).error).toMatch(/on-device analyser/)
  })

  it('uses its own token even when an API key guards the rest of the API', async () => {
    const { post, app } = unit({ apiKey: 'api' })
    expect((await post(batch(), 'tok')).status).toBe(200)
    expect((await app.request('/api/vision/analyzers', { headers: { 'x-forwarded-for': '10.0.0.9' } })).status).toBe(401)
  })

  it('rejects oversized bodies before parsing them', async () => {
    const { app } = unit()
    const r = await app.request('/api/analyses/results', { method: 'POST', headers: { 'authorization': 'Bearer tok', 'content-length': '6000000', 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(413)
  })
})

describe('storage router', () => {
  it('reports no mirror in the demo and tests', async () => {
    const { ctx } = unit()
    const c = createCallerFactory(appRouter)(ctx)
    expect(await c.storage.mirror()).toMatchObject({ available: false, enabled: false })
    expect(await c.storage.testMirror()).toMatchObject({ ok: false })
    await expect(c.storage.syncMirror()).rejects.toThrow(/no mirror/)
  })

  it('tests the bucket and copies existing stills and artifacts', async () => {
    const store = new MemoryStore()
    const objects = new Map<string, Uint8Array>()
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input as Request
      const path = new URL(req.url).pathname
      if (req.method === 'PUT') objects.set(path, new Uint8Array(await req.arrayBuffer()))
      if (req.method === 'DELETE') objects.delete(path)
      if (req.method === 'GET') return objects.has(path) ? new Response(objects.get(path) as BodyInit) : new Response(null, { status: 404 })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const local = new MemorySink()
    const mirror = new MirroredSink({ local, store, remote: cfg => new S3Sink(cfg, fetchImpl) })
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', sink: mirror, mirror })
    const c = createCallerFactory(appRouter)(core.ctx)
    await expect(c.storage.syncMirror()).rejects.toThrow(/not configured/)
    store.settings.update({ mirrorEndpoint: 'https://s3.example.com', mirrorBucket: 'pods', mirrorAccessKeyId: 'AK', mirrorSecretAccessKey: 'SK' })
    store.captures.add({ id: 'upper-1', camera: 'upper', ts: '2026-10-30T00:00:00Z', path: 'upper-1.jpg', bytes: 1 })
    store.captures.add({ id: 'demo', camera: 'lower', ts: '2026-10-30T00:00:00Z', path: 'data:image/svg+xml,x', bytes: 1 })
    await local.put('upper-1.jpg', new Uint8Array([1]))
    await local.put('analysis/upper-1/exg-otsu@1/mask.pbm', new Uint8Array([2]))
    store.analyses.add([0, 1].map(slot => ({ captureId: 'upper-1', ts: '2026-10-30T00:00:00Z', camera: 'upper' as const, analyzer: 'exg-otsu', version: 1, source: 'device' as const, slot, metric: 'green_fraction', value: 0.1, detail: null, artifact: 'analysis/upper-1/exg-otsu@1/mask.pbm' })))
    expect(await c.storage.testMirror()).toMatchObject({ ok: true })
    expect(await c.storage.syncMirror()).toEqual({ queued: 2 })
    await mirror.flush()
    expect([...objects.keys()].sort()).toEqual(['/pods/analysis/upper-1/exg-otsu%401/mask.pbm', '/pods/upper-1.jpg'])
    expect(await c.storage.mirror()).toMatchObject({ available: true, enabled: true, uploaded: 2 })
  })
})
