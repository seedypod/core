import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, staticCacheControl } from '../../server/app'
import { SimHal } from '../../src/hardware/sim'
import { createEventBus } from '../../src/lib/eventBus'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'

const script = resolve(import.meta.dirname, '../../scripts/precompress.mjs')
const IMMUTABLE = 'public, max-age=31536000, immutable'
const js = 'const garden = "tomato basil";\n'.repeat(200)
const page = `<!doctype html><title>seedypod</title>${'<!-- padding -->'.repeat(100)}`

let dir: string
let hal: SimHal
let app: ReturnType<typeof createApp>['app']
const get = (path: string, encoding?: string) => app.request(path, { headers: encoding ? { 'accept-encoding': encoding } : {} })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'static-'))
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, 'brand'))
  writeFileSync(join(dir, 'index.html'), page)
  writeFileSync(join(dir, 'assets/index-abc123.js'), js)
  writeFileSync(join(dir, 'assets/tiny-abc123.js'), 'export {}\n')
  writeFileSync(join(dir, 'assets/font-abc123.woff2'), Buffer.alloc(4096, 7))
  writeFileSync(join(dir, 'brand/icon.png'), Buffer.alloc(4096, 7))
  expect(spawnSync('node', [script, dir], { encoding: 'utf8' }).status).toBe(0)
  hal = new SimHal({ tickMs: 0 })
  const core = createCore({ hal, store: new MemoryStore(), events: createEventBus(), version: 'test' })
  app = createApp({ ctx: core.ctx, staticRoot: dir }).app
})

afterAll(async () => {
  await hal.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('scripts/precompress.mjs', () => {
  it('gzips text next to itself, and leaves small and already compressed files alone', () => {
    expect(readdirSync(join(dir, 'assets')).filter(f => f.endsWith('.gz'))).toEqual(['index-abc123.js.gz'])
    expect(readdirSync(join(dir, 'brand')).filter(f => f.endsWith('.gz'))).toEqual([])
    expect(gunzipSync(readFileSync(join(dir, 'assets/index-abc123.js.gz'))).toString()).toBe(js)
  })

  it('keeps a file that gzip would only grow uncompressed', () => {
    const d = mkdtempSync(join(tmpdir(), 'static-'))
    // Bytes with no pattern to find.
    writeFileSync(join(d, 'noise.js'), Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * i * 2654435761) >>> 24)))
    spawnSync('node', [script, d])
    expect(readdirSync(d)).toEqual(['noise.js'])
    rmSync(d, { recursive: true, force: true })
  })

  it('says how to call it', () => {
    const r = spawnSync('node', [script], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage')
  })
})

describe('static files', () => {
  it('sends the gzipped copy to a client that takes gzip', async () => {
    const r = await get('/assets/index-abc123.js', 'gzip, deflate')
    expect(r.headers.get('content-encoding')).toBe('gzip')
    expect(r.headers.get('vary')).toBe('Accept-Encoding')
    expect(r.headers.get('content-type')).toContain('text/javascript')
    const body = Buffer.from(await r.arrayBuffer())
    expect(body.length).toBeLessThan(js.length / 4)
    expect(Number(r.headers.get('content-length'))).toBe(body.length)
    expect(gunzipSync(body).toString()).toBe(js)
  })

  it('sends the file as it is to a client that doesn\'t', async () => {
    const r = await get('/assets/index-abc123.js')
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(await r.text()).toBe(js)
  })

  it('caches hashed assets for good, compressed or not', async () => {
    for (const r of [await get('/assets/index-abc123.js', 'gzip'), await get('/assets/index-abc123.js'), await get('/assets/font-abc123.woff2', 'gzip')]) {
      expect(r.headers.get('cache-control')).toBe(IMMUTABLE)
    }
  })

  it('makes the browser ask again for index.html, at / and on any SPA route', async () => {
    for (const path of ['/', '/index.html', '/light']) {
      const r = await get(path, 'gzip')
      expect(r.status).toBe(200)
      expect(r.headers.get('cache-control')).toBe('no-cache')
    }
  })

  it('never pins index.html under an old asset URL after an update', async () => {
    const r = await get('/assets/index-gone00.js', 'gzip')
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('cache-control')).toBe('no-cache')
  })

  it('keeps unhashed files a day', async () => {
    expect((await get('/brand/icon.png')).headers.get('cache-control')).toBe('public, max-age=86400')
  })

  it('leaves an error uncacheable', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'static-'))
    const core = createCore({ hal, store: new MemoryStore(), events: createEventBus(), version: 'test' })
    const r = await createApp({ ctx: core.ctx, staticRoot: empty }).app.request('/light')
    expect(r.status).toBe(404)
    expect(r.headers.get('cache-control')).toBeNull()
    rmSync(empty, { recursive: true, force: true })
  })

  it('treats a response with no type as a plain file', () => {
    expect(staticCacheControl('/brand/x', null)).toBe('public, max-age=86400')
  })

  it('leaves the event stream unbuffered and uncompressed', async () => {
    const r = await app.request('/api/trpc/events.onChange', { headers: { 'accept-encoding': 'gzip', 'accept': 'text/event-stream' } })
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('cache-control')).not.toContain('immutable')
    const reader = r.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    await reader?.cancel()
  })
})
