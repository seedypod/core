import { serve } from '@hono/node-server'
import { FsSink } from '../src/camera/fsSink'
import { createHal } from '../src/hardware/factory'
import { createEventBus } from '../src/lib/eventBus'
import { connectBridge } from '../src/mqtt/bridge'
import { createCore } from '../src/server/bootstrap'
import { SqliteStore } from '../src/store/sqlite'
import { createApp } from './app'
import { readVersion } from './version'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = process.env.DATA_DIR ?? './data'

const events = createEventBus()
const hal = await createHal({ events })
const store = new SqliteStore({ url: process.env.DATABASE_URL ?? `${DATA_DIR}/seedypod.db` })
const core = createCore({ hal, store, events, version: readVersion(), sink: new FsSink(`${DATA_DIR}/captures`), startServices: process.env.CI !== '1' })

// Core-level Home Assistant bridge (ADR-0013): dormant until settings.mqttUrl is set; reconnects on settings change.
let bridge = await connectBridge({ store, hal, events, unitId: hal.snapshot().system?.unitId ?? process.env.HAL_UNIT_ID ?? 'sim' }).catch((e: Error) => {
  console.warn(`HA bridge not started: ${e.message}`)
  return null
})
events.subscribe((e) => {
  if (e.kind === 'mutation' && e.path === 'settings') {
    bridge?.stop()
    void connectBridge({ store, hal, events, unitId: hal.snapshot().system?.unitId ?? 'sim' }).then(b => (bridge = b)).catch((err: Error) => console.warn(`HA bridge: ${err.message}`))
  }
})

const { app, injectWebSocket } = createApp({ ctx: core.ctx, staticRoot: './web/dist' })

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`seedypod core ${core.ctx.version} listening on http://${info.address}:${info.port}`)
})
injectWebSocket(server)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    bridge?.stop()
    void core.stop().finally(() => {
      server.close()
      process.exit(0)
    })
  })
}
