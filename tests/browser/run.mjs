// Boots the built server (simulator HAL) on a scratch port and runs Playwright.
// Phase 4.3 fills in real specs; until then this is a smoke that the server
// serves the SPA and the API answers, so the CI lane is wired end to end.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3218
const server = spawn('node', ['server/dist/index.js'], { env: { ...process.env, PORT: String(PORT), CI: '1' }, stdio: 'inherit' })
try {
  let ok = false
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(500)
    ok = await fetch(`http://127.0.0.1:${PORT}/api/healthcheck`).then(r => r.ok).catch(() => false)
  }
  if (!ok) throw new Error('server did not become healthy')
  const html = await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.text())
  if (!html.includes('<div id="root">')) throw new Error('SPA shell not served')
  const spec = await fetch(`http://127.0.0.1:${PORT}/api/openapi.json`).then(r => r.json())
  if (!spec.paths?.['/system']) throw new Error('OpenAPI spec missing /system')
  console.log('✓ browser smoke: server serves SPA + API')
}
finally {
  server.kill('SIGTERM')
}
