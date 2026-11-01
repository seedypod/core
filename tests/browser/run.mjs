// Boots the built server (simulator HAL, scratch SQLite) on :3218 and runs the
// Playwright e2e specs against it. Mirrors sleepypod's tests/browser/run.mjs.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3218
const dataDir = mkdtempSync(join(tmpdir(), 'seedypod-e2e-'))
// A stand-in SD card for the flash-writes meter: 1 GB written, a 32 GB card.
const block = join(dataDir, 'block/mmcblk0')
mkdirSync(block, { recursive: true })
writeFileSync(join(block, 'stat'), '5021 1544 412366 8133 2210 3122 1953125 14880 0 11440 23010\n')
writeFileSync(join(block, 'size'), '62500000\n')
// What a backup bundles besides the database: hal.toml and hald's state.
const etc = join(dataDir, 'etc')
const state = join(dataDir, 'hal-state')
mkdirSync(etc)
mkdirSync(state)
writeFileSync(join(etc, 'hal.toml'), 'unit_id = "sim-0001"\n')
writeFileSync(join(state, 'state.json'), '{"light_level":0}\n')
const env = {
  ...process.env, PORT: String(PORT), CI: '1', DATA_DIR: dataDir, DATABASE_URL: join(dataDir, 'e2e.db'), FLASH_STAT_PATH: join(block, 'stat'),
  SEEDYPOD_ETC_DIR: etc, SEEDYPOD_STATE_DIR: state, SEEDYPOD_MOSQUITTO_PASSWD: join(dataDir, 'no-passwd'),
  // The real restore helper; the specs only reach its checks, so the service commands are a no-op.
  SEEDYPOD_RESTORE_CMD: JSON.stringify([process.execPath, 'scripts/seedypod-restore.cjs']),
  SEEDYPOD_RESTORE_DB: join(dataDir, 'e2e.db'), SEEDYPOD_RESTORE_CAPTURES: join(dataDir, 'captures'),
  SEEDYPOD_RESTORE_WORK: join(dataDir, 'restore'), SEEDYPOD_SYSTEMCTL: JSON.stringify(['true']),
}
const server = spawn('node', ['server/dist/index.js'], { env, stdio: 'inherit' })
let code = 1
try {
  let ok = false
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(500)
    ok = await fetch(`http://127.0.0.1:${PORT}/api/healthcheck`).then(r => r.ok).catch(() => false)
  }
  if (!ok) throw new Error('server did not become healthy')
  // A fresh database opens on Welcome; the other specs start from a unit that's set up (welcome.e2e.ts resets it).
  await fetch(`http://127.0.0.1:${PORT}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupComplete: true }) })
  code = await new Promise((resolve) => {
    const pw = spawn('pnpm', ['exec', 'playwright', 'test', '--config', 'tests/browser/playwright.config.ts', ...process.argv.slice(2)], { env: { ...env, SEEDYPOD_E2E: '1' }, stdio: 'inherit' })
    pw.on('exit', c => resolve(c ?? 1))
  })
}
finally {
  server.kill('SIGTERM')
}
process.exit(code)
