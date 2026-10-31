import { serve } from '@hono/node-server'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FsSink } from '../src/camera/fsSink'
import { MirroredSink } from '../src/camera/mirrorSink'
import { createHal } from '../src/hardware/factory'
import { createEventBus } from '../src/lib/eventBus'
import { connectBridge } from '../src/mqtt/bridge'
import { NmcliWifi } from '../src/network/wifi'
import { createCore } from '../src/server/bootstrap'
import { SqliteStore } from '../src/store/sqlite'
import { nodeFlashSource } from '../src/telemetry/flashSource'
import { createWorkerExecutor } from '../src/vision/workerExecutor'
import { createApp } from './app'
import { readVersion } from './version'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = process.env.DATA_DIR ?? './data'

const events = createEventBus()
const hal = await createHal({ events })
const store = new SqliteStore({ url: process.env.DATABASE_URL ?? `${DATA_DIR}/seedypod.db` })
// Capture analysis runs on a worker thread when the bundled worker sits next to this file (a build);
// under `tsx watch` it runs inline.
const workerScript = new URL('./visionWorker.js', import.meta.url)
const vision = existsSync(fileURLToPath(workerScript)) ? createWorkerExecutor(workerScript) : null
// Stills and artifacts live under DATA_DIR/captures; the opt-in mirror copies them off the unit (ADR-0019).
const capturesDir = `${DATA_DIR}/captures`
const mirror = new MirroredSink({ local: new FsSink(capturesDir), store, events, keyOf: p => relative(capturesDir, p) })
// Wi-Fi setup drives NetworkManager; on a machine without nmcli the Wi-Fi screen says it's unavailable.
const nmcli = (args: string[]) => new Promise<string>((resolve, reject) => {
  execFile('nmcli', args, { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)))
})
const wifi = new NmcliWifi({ run: nmcli, unitId: hal.snapshot().system?.unitId ?? process.env.HAL_UNIT_ID ?? 'unit' })
const core = createCore({ hal, store, events, version: readVersion(), sink: mirror, mirror, startServices: process.env.CI !== '1', analysisExecutor: vision?.run, wifi, flashSource: nodeFlashSource() })

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
    void core.stop().then(() => vision?.close()).finally(() => {
      server.close()
      process.exit(0)
    })
  })
}
