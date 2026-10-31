import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { trpcServer } from '@hono/trpc-server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createOpenApiFetchHandler } from 'trpc-to-openapi'
import { createMcpServer } from '../src/mcp/server'
import type { Context } from '../src/server/context'
import { openApiDocument } from '../src/server/openapi'
import { appRouter } from '../src/server/routers/app'
import { apiKeyGuard } from './auth'

export interface CreateAppOptions {
  ctx: Context
  /** Directory of the built SPA; omit to skip static serving (tests). */
  staticRoot?: string
}

/**
 * Builds the Hono app. Kept separate from `index.ts` so integration tests can
 * mount it on an ephemeral port without touching process signals.
 */
export function createApp({ ctx, staticRoot }: CreateAppOptions) {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

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

  app.get('/api/openapi.json', c => c.json(openApiDocument(new URL('/api', c.req.url).toString())))

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
    const server = createMcpServer(ctx)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  // Everything else under /api is the OpenAPI REST facade of the tRPC router.
  app.all('/api/*', c => createOpenApiFetchHandler({ endpoint: '/api', router: appRouter, createContext: () => ({ ...ctx }), req: c.req.raw }))

  if (staticRoot) {
    app.use('/*', serveStatic({ root: staticRoot }))
    app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }))
  }

  return { app, injectWebSocket }
}
