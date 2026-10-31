import { serve } from '@hono/node-server'
import { FsSink } from '../src/camera/fsSink'
import { createHal } from '../src/hardware/factory'
import { createEventBus } from '../src/lib/eventBus'
import { createCore } from '../src/server/bootstrap'
import { SqliteStore } from '../src/store/sqlite'
import { createApp } from './app'
import { readVersion } from './version'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = process.env.DATA_DIR ?? './data'

const events = createEventBus()
const hal = await createHal({ events })
const store = new SqliteStore({ url: process.env.DATABASE_URL ?? `${DATA_DIR}/leafypod.db` })
const core = createCore({ hal, store, events, version: readVersion(), sink: new FsSink(`${DATA_DIR}/captures`), startServices: process.env.CI !== '1' })

const { app, injectWebSocket } = createApp({ ctx: core.ctx, staticRoot: './web/dist' })

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`leafypod core ${core.ctx.version} listening on http://${info.address}:${info.port}`)
})
injectWebSocket(server)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void core.stop().finally(() => {
      server.close()
      process.exit(0)
    })
  })
}
