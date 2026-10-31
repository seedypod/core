// Boots the built server (simulator HAL, scratch SQLite) on :3218 and runs the
// Playwright e2e specs against it. Mirrors sleepypod's tests/browser/run.mjs.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3218
const dataDir = mkdtempSync(join(tmpdir(), 'seedypod-e2e-'))
const env = { ...process.env, PORT: String(PORT), CI: '1', DATA_DIR: dataDir, DATABASE_URL: join(dataDir, 'e2e.db') }
const server = spawn('node', ['server/dist/index.js'], { env, stdio: 'inherit' })
let code = 1
try {
  let ok = false
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(500)
    ok = await fetch(`http://127.0.0.1:${PORT}/api/healthcheck`).then(r => r.ok).catch(() => false)
  }
  if (!ok) throw new Error('server did not become healthy')
  code = await new Promise((resolve) => {
    const pw = spawn('pnpm', ['exec', 'playwright', 'test', '--config', 'tests/browser/playwright.config.ts'], { env: { ...env, SEEDYPOD_E2E: '1' }, stdio: 'inherit' })
    pw.on('exit', c => resolve(c ?? 1))
  })
}
finally {
  server.kill('SIGTERM')
}
process.exit(code)
