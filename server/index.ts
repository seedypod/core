import { serve } from '@hono/node-server'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { arch, hostname } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latestStill } from '../src/camera/captures'
import { FsSink } from '../src/camera/fsSink'
import { RestoreClient, restoreCommand } from '../src/backup/restore'
import { BackupService } from '../src/backup/service'
import { backupPaths, nodeBackupSources } from '../src/backup/sources'
import { MirroredSink } from '../src/camera/mirrorSink'
import { NodeDatabaseInspector } from '../src/db/inspector'
import { seedIfFresh } from '../src/demo/seed'
import { createHal } from '../src/hardware/factory'
import { HomeKitService } from '../src/homekit/service'
import { createEventBus } from '../src/lib/eventBus'
import { installRecordingPolicy, policyPath, RecordingPolicy } from '../src/logging/policy'
import { bridgeStatus, connectBridge, superviseBridge } from '../src/mqtt/bridge'
import { CoreAdvertiser } from '../src/network/mdns'
import { NmcliWifi } from '../src/network/wifi'
import { nodeClockTrusted } from '../src/scheduler/clock'
import { createCore } from '../src/server/bootstrap'
import { defaultMigrationsFolder, SqliteStore } from '../src/store/sqlite'
import { nodeDiskUsage, nodeFlashSource } from '../src/telemetry/flashSource'
import { UpdateClient, updateCommand } from '../src/update/client'
import { installLearned } from '../src/vision/analyzer'
import { FsModelFiles, sha256 } from '../src/vision/modelFiles'
import { inlineExecutor } from '../src/vision/execute'
import { learnedAnalyzers, type LearnedSpec } from '../src/vision/podState'
import { withPodvision } from '../src/vision/podvision'
import { ModelRegistry } from '../src/vision/registry'
import { createWorkerExecutor } from '../src/vision/workerExecutor'
import { createApp } from './app'
import { flushCompileCacheSoon } from './compileCache'
import { readVersion } from './version'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = process.env.DATA_DIR ?? './data'

const dbPath = process.env.DATABASE_URL ?? `${DATA_DIR}/seedypod.db`
// Only on a unit, so `pnpm dev` and the tests see everything.
const logging = new RecordingPolicy({ path: policyPath(process.env, dbPath) })
if (process.env.NODE_ENV === 'production') installRecordingPolicy(logging)
const events = createEventBus()
const hal = await createHal({ events })
const store = new SqliteStore({ url: dbPath })
// SEED_DEMO=1 fills a new database with the browser demo's story, for testing on the simulator.
if (process.env.SEED_DEMO === '1' && seedIfFresh(store, hal)) console.log('seeded the demo data (SEED_DEMO=1)')
// Capture analysis runs on a worker thread when the bundled worker sits next to this file (a build);
// under `tsx watch` it runs inline.
// Learned pod-state models (#185, #186): the release's models/pod-state.json plus any uploaded under DATA_DIR/models.
// This thread lists the enabled ones and the worker runs them, both from the same files' text.
const workerScript = new URL('./visionWorker.js', import.meta.url)
let learned: LearnedSpec[] = []
const models = new ModelRegistry({
  files: new FsModelFiles(join(DATA_DIR, 'models')),
  sha256,
  onChange: (specs) => {
    learned = specs
    installLearned(learnedAnalyzers(specs))
    vision?.configure(specs)
  },
})
learned = models.specs()
installLearned(learnedAnalyzers(learned))
const vision = existsSync(fileURLToPath(workerScript)) ? createWorkerExecutor(workerScript, undefined, learned) : null
// The native runner (#191) scores the learned ones at nice 19 when the release carries it; the worker stays the fallback.
const analysisExecutor = withPodvision(vision?.run ?? inlineExecutor, () => learned)
// The Database view scans read-only on a worker thread, the same way.
const inspectScript = new URL('./inspectWorker.js', import.meta.url)
const database = new NodeDatabaseInspector({ path: dbPath, migrationsFolder: defaultMigrationsFolder(), worker: existsSync(fileURLToPath(inspectScript)) ? inspectScript : null })
// Stills and artifacts live under DATA_DIR/captures; the opt-in mirror copies them off the unit (ADR-0019).
const capturesDir = `${DATA_DIR}/captures`
const mirror = new MirroredSink({ local: new FsSink(capturesDir), store, events, keyOf: p => relative(capturesDir, p) })
// Wi-Fi setup drives NetworkManager; on a machine without nmcli the Wi-Fi screen says it's unavailable.
const nmcli = (args: string[]) => new Promise<string>((resolve, reject) => {
  execFile('nmcli', args, { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)))
})
const wifi = new NmcliWifi({ run: nmcli, unitId: hal.snapshot().system?.unitId ?? process.env.HAL_UNIT_ID ?? 'unit' })
// Off-card backups (ADR-0021): download any time, nightly to the mirror's bucket when one is set.
const version = readVersion()
const backup = new BackupService({
  store, hal, events, version, mirror,
  sources: nodeBackupSources({ paths: backupPaths(process.env, DATA_DIR), snapshot: dest => store.backupTo(dest), migrationsFolder: defaultMigrationsFolder() }),
})
// Restores go through the root helper scripts/install puts in /usr/local/sbin (ADR-0021).
const restore = new RestoreClient({ command: restoreCommand(), workDir: process.env.SEEDYPOD_RESTORE_WORK || '/var/lib/seedypod-restore', uploadDir: DATA_DIR })
// Updates go through the root helper scripts/install puts in /usr/local/sbin (ADR-0026).
const update = new UpdateClient({ command: updateCommand(), workDir: process.env.SEEDYPOD_UPDATE_WORK || '/var/lib/seedypod-update', version, events })
// HomeKit (ADR 0023): off until turned on in Settings; hap-nodejs loads only then. Its files sit next to the database so backups carry them.
const homekit = new HomeKitService({ store, hal, events, version, dir: join(DATA_DIR, 'homekit') })
// Core-level Home Assistant bridge (ADR-0013): dormant until settings.mqttUrl is set; reconnects on settings change.
// System › Status reads its state, and the last connect error, through the context.
const haBridge = superviseBridge(() => connectBridge({ store, hal, events, unitId: hal.snapshot().system?.unitId ?? process.env.HAL_UNIT_ID ?? 'sim', stills: camera => latestStill(store, mirror, camera) }), events)
// hald's boot log survives the reboots the journal doesn't; world-readable, so core can read it.
const bootLog = () => readFile(join(backupPaths(process.env, DATA_DIR).stateDir, 'boot-log'), 'utf8').catch(() => null)
const core = createCore({ hal, store, events, version, sink: mirror, mirror, backup, restore, update, bootLog, homekit, startServices: process.env.CI !== '1', analysisExecutor, models, wifi, clockTrusted: () => nodeClockTrusted(), flashSource: nodeFlashSource(), database, logging, disk: nodeDiskUsage(DATA_DIR), bridge: () => bridgeStatus(store.settings.get().mqttUrl, haBridge.bridge(), haBridge.error()), host: { hostname: hostname(), arch: arch() } })

const { app, injectWebSocket } = createApp({ ctx: core.ctx, staticRoot: './web/dist' })

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`seedypod core ${core.ctx.version} listening on http://${info.address}:${info.port}`)
})
injectWebSocket(server)
flushCompileCacheSoon()
void homekit.startIfEnabled()
// Bonjour `_seedypod._tcp` for the iOS app (ADR-0017); SEEDYPOD_MDNS=0 turns it off.
const mdns = new CoreAdvertiser({ store, hal, events, version, port: PORT, host: HOST, hostname: hostname() })
void mdns.start()

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // First, so a teardown step that hangs or fails can't cost the held telemetry.
    store.telemetry.flush()
    haBridge.stop()
    void mdns.stop().then(() => core.stop()).then(() => vision?.close()).finally(() => {
      server.close()
      process.exit(0)
    })
  })
}
