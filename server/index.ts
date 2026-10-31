import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { trpcServer } from '@hono/trpc-server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createOpenApiFetchHandler } from 'trpc-to-openapi'
import { createHal } from '../src/hardware/factory'
import { createEventBus } from '../src/lib/eventBus'
import { createMcpServer } from '../src/mcp/server'
import { openApiDocument } from '../src/server/openapi'
import { appRouter } from '../src/server/routers/app'
import type { Context } from '../src/server/context'
import { readVersion } from './version'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

const events = createEventBus()
const hal = await createHal({ events })
const ctx: Context = { hal, events, version: readVersion() }

const app = new Hono()

app.use('/api/*', cors({ origin: origin => origin ?? '*' }))

app.use('/api/trpc/*', trpcServer({ endpoint: '/api/trpc', router: appRouter, createContext: () => ({ ...ctx }) }))

app.get('/api/openapi.json', c => c.json(openApiDocument(new URL('/api', c.req.url).toString())))

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
app.all('/api/*', c => createOpenApiFetchHandler({ endpoint: '/api', router: appRouter, createContext: () => ctx, req: c.req.raw }))

app.use('/*', serveStatic({ root: './web/dist' }))
app.get('*', serveStatic({ root: './web/dist', path: 'index.html' }))

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`leafypod core ${ctx.version} listening on http://${info.address}:${info.port}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void hal.close().finally(() => {
      server.close()
      process.exit(0)
    })
  })
}
