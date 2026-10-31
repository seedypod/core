import { serve } from '@hono/node-server'
import { createHal } from '../src/hardware/factory'
import { createEventBus } from '../src/lib/eventBus'
import type { Context } from '../src/server/context'
import { createApp } from './app'
import { readVersion } from './version'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

const events = createEventBus()
const hal = await createHal({ events })
const ctx: Context = { hal, events, version: readVersion() }

const { app, injectWebSocket } = createApp({ ctx, staticRoot: './web/dist' })

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`leafypod core ${ctx.version} listening on http://${info.address}:${info.port}`)
})
injectWebSocket(server)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void hal.close().finally(() => {
      server.close()
      process.exit(0)
    })
  })
}
