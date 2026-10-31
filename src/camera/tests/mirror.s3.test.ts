/**
 * The mirror against a real S3-compatible server (MinIO, R2, …), not a fake.
 * Opt-in: set MIRROR_TEST_ENDPOINT, MIRROR_TEST_ACCESS_KEY and MIRROR_TEST_SECRET
 * (and optionally MIRROR_TEST_REGION). With MIRROR_TEST_BUCKET it uses that existing
 * bucket (an R2 object-scoped token can't create buckets) under a fresh prefix;
 * otherwise it creates its own bucket and deletes it afterwards. Either way it
 * removes every object it wrote. `.github/workflows/mirror-s3.yml` runs it in CI.
 *
 *   MIRROR_TEST_ENDPOINT=http://127.0.0.1:9000 MIRROR_TEST_ACCESS_KEY=… MIRROR_TEST_SECRET=… pnpm exec vitest run src/camera/tests/mirror.s3.test.ts
 */
import { AwsClient } from 'aws4fetch'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import { MemorySink } from '../captures'
import { MirroredSink, S3Sink, type MirrorConfig } from '../mirrorSink'

const endpoint = process.env.MIRROR_TEST_ENDPOINT
const accessKeyId = process.env.MIRROR_TEST_ACCESS_KEY ?? ''
const secretAccessKey = process.env.MIRROR_TEST_SECRET ?? ''
const region = process.env.MIRROR_TEST_REGION ?? 'us-east-1'

describe.skipIf(!endpoint)('mirror against a real S3-compatible server', () => {
  const own = !process.env.MIRROR_TEST_BUCKET
  const bucket = process.env.MIRROR_TEST_BUCKET ?? `seedypod-test-${Date.now().toString(36)}`
  const run = `seedypod-test-${Date.now().toString(36)}/`
  const cfg: MirrorConfig = { endpoint: endpoint ?? '', bucket, region, prefix: `${run}kitchen/`, accessKeyId, secretAccessKey }
  const admin = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' })
  const bucketUrl = `${(endpoint ?? '').replace(/\/+$/, '')}/${bucket}`

  it('signs real requests: put, get, 404, delete, and a bad secret is refused', async () => {
    if (own) expect((await admin.fetch(bucketUrl, { method: 'PUT' })).status).toBe(200)
    const s3 = new S3Sink(cfg)
    const jpeg = new Uint8Array([0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9])
    await s3.put('upper-2026-10-31T12-00-00-000Z.jpg', jpeg)
    await s3.put('analysis/upper-1/exg-otsu@1/mask.pbm', new Uint8Array([0x50, 0x34]))
    expect([...(await s3.get('upper-2026-10-31T12-00-00-000Z.jpg')) ?? []]).toEqual([...jpeg])
    expect([...(await s3.get('analysis/upper-1/exg-otsu@1/mask.pbm')) ?? []]).toEqual([0x50, 0x34])
    expect(await s3.get('missing.jpg')).toBeNull()
    await s3.remove('upper-2026-10-31T12-00-00-000Z.jpg')
    expect(await s3.get('upper-2026-10-31T12-00-00-000Z.jpg')).toBeNull()
    await expect(new S3Sink({ ...cfg, secretAccessKey: 'wrong' }).put('x.jpg', jpeg)).rejects.toThrow(/403/)
  })

  it('copies stills in the background, keeps them after a local prune, and drives the storage API', async () => {
    const store = new MemoryStore()
    store.settings.update({ mirrorEndpoint: cfg.endpoint, mirrorBucket: bucket, mirrorRegion: region, mirrorPrefix: `${run}unit/`, mirrorAccessKeyId: accessKeyId, mirrorSecretAccessKey: secretAccessKey })
    const local = new MemorySink()
    const mirror = new MirroredSink({ local, store })
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', sink: mirror, mirror })
    const c = createCallerFactory(appRouter)(core.ctx)

    expect(await c.storage.testMirror()).toEqual({ ok: true, detail: 'wrote, read back and deleted a probe object' })
    await mirror.put('lower-1.jpg', new Uint8Array([9, 9, 9]))
    await mirror.flush()
    await mirror.remove('lower-1.jpg')
    expect(await local.get('lower-1.jpg')).toBeNull()
    expect([...(await mirror.get('lower-1.jpg')) ?? []]).toEqual([9, 9, 9])

    await local.put('old.jpg', new Uint8Array([1]))
    store.captures.add({ id: 'old', camera: 'upper', ts: '2026-10-30T00:00:00Z', path: 'old.jpg', bytes: 1 })
    expect(await c.storage.syncMirror()).toEqual({ queued: 1 })
    await mirror.flush()
    expect(await c.storage.mirror()).toMatchObject({ available: true, enabled: true, failed: 0, uploaded: 2, lastError: null })
    expect([...(await new S3Sink({ ...cfg, prefix: `${run}unit/` }).get('old.jpg')) ?? []]).toEqual([1])

    // Tidy up so the bucket can be deleted.
    const s3 = new S3Sink({ ...cfg, prefix: run })
    for (const key of ['unit/lower-1.jpg', 'unit/old.jpg', 'kitchen/analysis/upper-1/exg-otsu@1/mask.pbm']) await s3.remove(key)
    for (const key of ['unit/lower-1.jpg', 'unit/old.jpg']) expect(await s3.get(key)).toBeNull()
    if (own) expect((await admin.fetch(bucketUrl, { method: 'DELETE' })).status).toBe(204)
  })
})
