import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { datasetEntries, datasetName, resolveWindow } from '../src/datasets/export'
import { tarStream } from '../src/datasets/tar'
import { RestoreRefused } from '../src/backup/restore'
import type { Context } from '../src/server/context'
import { appRouter } from '../src/server/routers/app'
import { IngestBatch, IngestRefused, ingestResults } from '../src/vision/ingest'
import { MAX_MODEL_BYTES, ModelRefused } from '../src/vision/registry'
import { apiKeyGuard, timingSafeEqual } from './auth'

export interface CreateAppOptions {
  ctx: Context
  /** Directory of the built SPA; omit to skip static serving (tests). */
  staticRoot?: string
}

/**
 * How long a browser may keep a file of the SPA. Vite names everything under
 * `/assets/` by content, so a changed file is a new URL. HTML is asked for
 * again or an update would never show, and that goes by type, not path: an
 * asset gone after an update falls back to `index.html` at its old URL, which
 * must not be pinned there.
 */
export function staticCacheControl(path: string, contentType: string | null): string {
  if (contentType?.startsWith('text/html')) return 'no-cache'
  return path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400'
}

/**
 * Builds the Hono app. Kept separate from `index.ts` so integration tests can
 * mount it on an ephemeral port without touching process signals.
 */
export function createApp({ ctx, staticRoot }: CreateAppOptions) {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // Off-device results (ADR-0019) authenticate with their own token, so this route sits before the API-key guard.
  app.post('/api/analyses/results', async (c) => {
    const token = ctx.store.settings.get().analysisIngestToken
    if (!token) return c.json({ error: 'result ingest is off; set an ingest token in Settings' }, 404)
    const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!given || !timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401)
    if (Number(c.req.header('content-length') ?? 0) > 5_000_000) return c.json({ error: 'batch over 5 MB; post fewer results per request' }, 413)
    const parsed = IngestBatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid batch', issues: parsed.error.issues }, 400)
    try {
      const out = ingestResults(ctx.store, parsed.data)
      ctx.events.emit({ kind: 'mutation', path: 'analyses' })
      return c.json(out)
    }
    catch (e) {
      if (e instanceof IngestRefused) return c.json({ error: e.message }, 409)
      throw e
    }
  })

  // Model uploads (#186) use the same token, so a training machine needs only that one secret.
  app.post('/api/models', async (c) => {
    const token = ctx.store.settings.get().analysisIngestToken
    if (!token) return c.json({ error: 'uploads are off; set an ingest token in Settings' }, 404)
    const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!given || !timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401)
    if (!ctx.models) return c.json({ error: 'the model registry runs only on a unit' }, 404)
    if (Number(c.req.header('content-length') ?? 0) > MAX_MODEL_BYTES) return c.json({ error: `weights file over ${MAX_MODEL_BYTES} bytes` }, 413)
    const sha = c.req.header('x-content-sha256') ?? c.req.query('sha256')
    if (!sha) return c.json({ error: 'send the file\'s SHA-256 in X-Content-SHA256 or ?sha256=' }, 400)
    try {
      const out = ctx.models.upload(await c.req.text(), sha, { enable: c.req.query('enable') === '1' || c.req.query('enable') === 'true' })
      ctx.events.emit({ kind: 'mutation', path: 'analyses' })
      return c.json(out, 201)
    }
    catch (e) {
      if (e instanceof ModelRefused) return c.json({ error: e.message }, e.status)
      throw e
    }
  })

  app.use('/api/*', cors({ origin: origin => origin ?? '*' }))
  app.use('/api/*', apiKeyGuard(ctx.store))

  app.use('/api/trpc/*', trpcServer({ endpoint: '/api/trpc', router: appRouter, createContext: () => ({ ...ctx }) }))

  app.get('/api/captures/:file', async (c) => {
    const id = c.req.param('file').replace(/\.jpg$/, '')
    const got = await ctx.captures.bytes(id)
    if (!got) return c.text('not found', 404)
    if (got.capture.path.startsWith('data:')) return c.redirect(got.capture.path)
    const body = new Uint8Array(got.bytes).buffer as ArrayBuffer
    return c.body(body, 200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' })
  })

  // The newest stored still, for Home Assistant's generic camera (ADR 0027). Never takes a new one.
  app.get('/api/camera/:camera/latest.jpg', async (c) => {
    const camera = c.req.param('camera')
    if (camera !== 'upper' && camera !== 'lower') return c.text('not found', 404)
    const got = await ctx.captures.latest(camera)
    if (!got) return c.text('no still yet', 404)
    if (got.capture.path.startsWith('data:')) return c.redirect(got.capture.path)
    const body = new Uint8Array(got.bytes).buffer as ArrayBuffer
    return c.body(body, 200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'last-modified': new Date(got.capture.ts).toUTCString() })
  })

  // The latest full-size pod-ID still (#224), taken only by camera.capturePodId.
  app.get('/api/camera/:camera/podid.jpg', async (c) => {
    const camera = c.req.param('camera')
    if (camera !== 'upper' && camera !== 'lower') return c.text('not found', 404)
    const got = await ctx.captures.podId(camera)
    if (!got) return c.text('no pod-ID still yet', 404)
    const body = new Uint8Array(got.bytes).buffer as ArrayBuffer
    return c.body(body, 200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'last-modified': new Date(got.still.ts).toUTCString() })
  })

  // Dataset export (ADR-0019): a tar streamed entry by entry, so a month of stills never sits in memory.
  app.get('/api/datasets/export', (c) => {
    let w
    try {
      w = resolveWindow(ctx.now?.() ?? new Date(), { from: c.req.query('from'), to: c.req.query('to'), images: c.req.query('images') !== '0' })
    }
    catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const name = datasetName(ctx.store.settings.get().unitName, w)
    return c.body(tarStream(datasetEntries(ctx, w)), 200, { 'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="${name}.tar"` })
  })

  // A line per boot from hald, for reading away from the unit. Read-only: nothing in it is secret.
  app.get('/api/system/boot-log', async (c) => {
    const text = await ctx.bootLog?.()
    if (!text) return c.json({ error: 'no boot log on this core yet' }, 404)
    return c.body(text, 200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="seedypod-boot-log.txt"' })
  })

  // Backup bundle (ADR-0021): streamed; counts as an off-card backup once fully sent.
  app.get('/api/backup/download', async (c) => {
    if (!ctx.backup) return c.json({ error: 'this core has no backups (demo or tests)' }, 404)
    const { name, stream } = await ctx.backup.download({ photos: c.req.query('photos') === '1' })
    return c.body(stream, 200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' })
  })

  // Restore from an uploaded bundle (ADR-0021): the helper checks it before answering, then restarts the unit.
  app.post('/api/backup/restore', async (c) => {
    if (!ctx.restore?.available) return c.json({ error: 'restore isn\'t installed on this core: run scripts/install on the unit', code: 'unavailable' }, 412)
    const body = c.req.raw.body
    if (!body) return c.json({ error: 'send the backup file as the request body', code: 'invalid' }, 400)
    try {
      const bundle = await ctx.restore.restore(path => pipeline(Readable.fromWeb(body as NodeReadableStream), createWriteStream(path)))
      return c.json({ ok: true, restarting: true, bundle }, 202)
    }
    catch (e) {
      if (!(e instanceof RestoreRefused)) throw e
      return c.json({ error: e.message, code: e.code }, e.code === 'newer-schema' ? 409 : e.code === 'invalid' ? 400 : 500)
    }
  })

  // The MCP and OpenAPI stacks load on first use: they're over a third of the bundle, and the UI and the iOS app only use tRPC.
  app.get('/api/openapi.json', async (c) => {
    const { openApiDocument } = await import('../src/server/openapi')
    return c.json(openApiDocument(new URL('/api', c.req.url).toString()))
  })

  // Raw event stream over WebSocket (ADR-0005 amendment). Same CoreEvent frames
  // as the SSE subscription; for clients that can't do tRPC (dashboards, M5
  // dials, scripts). Read-only: commands go through tRPC/REST/MQTT.
  app.get('/api/ws', upgradeWebSocket(() => {
    let unsub: (() => void) | null = null
    return {
      onOpen(_evt, ws) {
        ws.send(JSON.stringify({ kind: 'hello', snapshot: ctx.hal.snapshot(), version: ctx.version }))
        unsub = ctx.events.subscribe(e => ws.send(JSON.stringify(e)))
      },
      onClose() {
        unsub?.()
        unsub = null
      },
    }
  }))

  app.all('/api/mcp', async (c) => {
    // DNS-rebinding guard: a browser on another origin must not reach the MCP endpoint.
    const origin = c.req.header('origin')
    const host = c.req.header('host')
    if (origin && host && new URL(origin).host !== host) return c.text('forbidden', 403)
    const [{ createMcpServer }, { WebStandardStreamableHTTPServerTransport }] = await Promise.all([
      import('../src/mcp/server'),
      import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'),
    ])
    const server = createMcpServer(ctx)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  // Everything else under /api is the OpenAPI REST facade of the tRPC router.
  app.all('/api/*', async (c) => {
    const { createOpenApiFetchHandler } = await import('trpc-to-openapi')
    return createOpenApiFetchHandler({ endpoint: '/api', router: appRouter, createContext: () => ({ ...ctx }), req: c.req.raw })
  })

  if (staticRoot) {
    // After the fact: serveStatic has built its response by the time its onFound runs, so headers set there are lost.
    app.use('/*', async (c, next) => {
      await next()
      if (c.res.ok) c.header('cache-control', staticCacheControl(c.req.path, c.res.headers.get('content-type')))
    })
    // The `.gz` files come from the build (scripts/precompress.mjs): a Pi's one core shouldn't gzip per request.
    app.use('/*', serveStatic({ root: staticRoot, precompressed: true }))
    app.get('*', serveStatic({ root: staticRoot, path: 'index.html', precompressed: true }))
  }

  return { app, injectWebSocket }
}
