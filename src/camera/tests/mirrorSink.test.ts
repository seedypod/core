import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { MemorySink, type BlobSink } from '../captures'
import { MirroredSink, mirrorConfig, S3Sink, type MirrorConfig } from '../mirrorSink'

const cfg: MirrorConfig = { endpoint: 'https://s3.example.com/', bucket: 'pods', region: 'auto', prefix: 'kitchen/', accessKeyId: 'AKID', secretAccessKey: 'secret' }
const configured = (store: MemoryStore) => store.settings.update({ mirrorEndpoint: cfg.endpoint, mirrorBucket: cfg.bucket, mirrorPrefix: cfg.prefix, mirrorAccessKeyId: cfg.accessKeyId, mirrorSecretAccessKey: cfg.secretAccessKey })

/** An in-memory bucket behind a fetch, recording every request. */
function fakeS3(failPuts = 0) {
  const objects = new Map<string, Uint8Array>()
  const requests: Request[] = []
  let failures = failPuts
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const req = input as Request
    requests.push(req)
    const path = new URL(req.url).pathname
    if (req.method === 'PUT') {
      if (failures-- > 0) return new Response('SlowDown', { status: 503 })
      objects.set(path, new Uint8Array(await req.arrayBuffer()))
      return new Response(null, { status: 200 })
    }
    if (req.method === 'GET') {
      const o = objects.get(path)
      return o ? new Response(o as BodyInit) : new Response('NoSuchKey', { status: 404 })
    }
    if (req.method === 'DELETE') {
      objects.delete(path)
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 405 })
  }) as typeof fetch
  return { objects, requests, fetchImpl }
}

describe('S3Sink', () => {
  it('signs path-style requests with SigV4 and maps 404 to null', async () => {
    const s3 = fakeS3()
    const sink = new S3Sink(cfg, s3.fetchImpl)
    expect(sink.url('analysis/upper-1/exg-otsu@1/mask.pbm')).toBe('https://s3.example.com/pods/kitchen/analysis/upper-1/exg-otsu%401/mask.pbm')
    expect(await sink.put('upper-1.jpg', new Uint8Array([0xFF, 0xD8]))).toBe('upper-1.jpg')
    const put = s3.requests[0] as Request
    expect(put.method).toBe('PUT')
    expect(put.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*, Signature=[0-9a-f]{64}$/)
    expect(put.headers.get('x-amz-content-sha256')).toBeTruthy()
    expect(put.headers.get('content-type')).toBe('image/jpeg')
    expect([...(await sink.get('upper-1.jpg')) ?? []]).toEqual([0xFF, 0xD8])
    expect(await sink.get('missing.jpg')).toBeNull()
    await sink.remove('upper-1.jpg')
    await sink.remove('upper-1.jpg')
    expect(s3.objects.size).toBe(0)
  })

  it('surfaces server errors', async () => {
    const broken = new S3Sink(cfg, (async () => new Response('AccessDenied', { status: 403 })) as typeof fetch)
    await expect(broken.put('a.pbm', new Uint8Array([1]))).rejects.toThrow(/403 AccessDenied/)
    await expect(broken.get('a')).rejects.toThrow(/403/)
    await expect(broken.remove('a')).rejects.toThrow(/403/)
  })

  it('is configured only when endpoint, bucket and both keys are set', () => {
    const store = new MemoryStore()
    expect(mirrorConfig(store.settings.get())).toBeNull()
    store.settings.update({ mirrorEndpoint: cfg.endpoint, mirrorBucket: 'pods', mirrorAccessKeyId: 'AKID' })
    expect(mirrorConfig(store.settings.get())).toBeNull()
    configured(store)
    expect(mirrorConfig({ ...store.settings.get(), mirrorRegion: '' })?.region).toBe('auto')
  })
})

describe('MirroredSink', () => {
  function setup(opts: { failPuts?: number, configure?: boolean } = {}) {
    const store = new MemoryStore()
    if (opts.configure !== false) configured(store)
    const local = new MemorySink()
    const s3 = fakeS3(opts.failPuts)
    const sink = new MirroredSink({ local, store, keyOf: p => p.replace(/^\/data\//, ''), remote: c => new S3Sink(c, s3.fetchImpl), retryDelayMs: 1, now: () => new Date('2026-10-31T00:00:00Z') })
    return { store, local, s3, sink }
  }

  it('does nothing off-device until configured', async () => {
    const { sink, s3 } = setup({ configure: false })
    expect(await sink.put('a.jpg', new Uint8Array([1]))).toBe('a.jpg')
    await sink.flush()
    expect(s3.requests).toHaveLength(0)
    expect(sink.status()).toMatchObject({ enabled: false, uploaded: 0 })
    expect(await sink.test()).toEqual({ ok: false, detail: 'the mirror is not configured' })
    await expect(sink.sync(['a.jpg'])).rejects.toThrow(/not configured/)
  })

  it('writes locally first, copies in the background and keeps the copy after a local prune', async () => {
    const { sink, s3, local } = setup()
    expect(await sink.put('a.jpg', new Uint8Array([7]))).toBe('a.jpg')
    expect(await local.get('a.jpg')).not.toBeNull()
    await sink.flush()
    expect(s3.objects.has('/pods/kitchen/a.jpg')).toBe(true)
    expect(sink.status()).toMatchObject({ enabled: true, uploaded: 1, pending: 0, failed: 0, lastUploadAt: '2026-10-31T00:00:00.000Z' })
    await sink.remove('a.jpg')
    expect(await local.get('a.jpg')).toBeNull()
    expect(s3.objects.has('/pods/kitchen/a.jpg')).toBe(true)
    // Reads fall back to the mirror, mapping the local path back to its key.
    expect([...(await sink.get('/data/a.jpg')) ?? []]).toEqual([7])
    expect(await sink.get('/data/never.jpg')).toBeNull()
  })

  it('retries, then raises mirror_failed; the next success clears it', async () => {
    const { sink, store } = setup({ failPuts: 3 })
    await sink.put('a.jpg', new Uint8Array([1]))
    await sink.flush()
    expect(sink.status()).toMatchObject({ failed: 1, uploaded: 0 })
    expect(sink.status().lastError).toMatch(/503/)
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind)).toEqual(['mirror_failed'])
    await sink.put('b.jpg', new Uint8Array([2]))
    await sink.flush()
    expect(sink.status()).toMatchObject({ uploaded: 1, lastError: null })
    expect(store.alerts.list({ activeOnly: true })).toEqual([])
  })

  it('copies existing blobs on request and tests the bucket end to end', async () => {
    const { sink, s3, local } = setup()
    await local.put('old.jpg', new Uint8Array([1]))
    expect(await sink.sync(['old.jpg', 'gone.jpg'])).toBe(1)
    await sink.flush()
    expect(s3.objects.has('/pods/kitchen/old.jpg')).toBe(true)
    expect(await sink.test()).toEqual({ ok: true, detail: 'wrote, read back and deleted a probe object' })
    expect([...s3.objects.keys()].some(k => k.includes('.seedypod-probe'))).toBe(false)
  })

  it('reports a failing bucket from test() and a broken mirror read as a miss', async () => {
    const store = new MemoryStore()
    configured(store)
    const failing: BlobSink = {
      put: async () => {
        throw new Error('AccessDenied')
      },
      get: async () => {
        throw new Error('down')
      },
      remove: async () => {},
    }
    const sink = new MirroredSink({ local: new MemorySink(), store, remote: () => failing })
    expect(await sink.test()).toEqual({ ok: false, detail: 'AccessDenied' })
    expect(await sink.get('x')).toBeNull()
    const blank: BlobSink = { put: async k => k, get: async () => new Uint8Array([0]), remove: async () => {} }
    expect((await new MirroredSink({ local: new MemorySink(), store, remote: () => blank }).test()).ok).toBe(false)
  })
})
