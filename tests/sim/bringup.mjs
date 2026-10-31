#!/usr/bin/env node
// Simulated Phase 1 bring-up: the full stack as it runs on a unit, with the
// Gardyn replaced by `hald --sim`. An in-process MQTT broker (aedes) stands
// in for Mosquitto, core runs the real MqttHalClient against it, and every
// check goes through core's public REST API or the HAL contract topics.
// Validates the software chain end to end; it cannot validate the pin map.
//
// Usage: pnpm build && cargo build -p hald, then `pnpm test:sim-bringup`
// (HALD_BIN=<path> to use another binary).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Aedes } from 'aedes'
import mqtt from 'mqtt'

const root = resolve(import.meta.dirname, '../..')
const hald = process.env.HALD_BIN ?? join(root, 'hal/target/debug/hald')
const unit = 'sim-bringup'
const work = mkdtempSync(join(tmpdir(), 'seedypod-bringup-'))
const children = []
const results = []

const freePort = () => new Promise((res, rej) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => res(port))
  }).on('error', rej)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(what, fn, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    }
    catch (e) { last = e }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail ?? '' })
  }
  catch (e) {
    results.push({ name, ok: false, detail: e.message })
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const [brokerPort, halHttpPort, corePort, s3Port, controlPort] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort()]
const api = `http://127.0.0.1:${corePort}/api`
const get = async path => (await fetch(`${api}${path}`)).json()
const post = async (path, body) => {
  const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// A fully fitted unit: the stock sensor set plus an EZO pH probe, a doser and one camera.
const config = join(work, 'hal.toml')
writeFileSync(config, `unit_id = "${unit}"
http_bind = "127.0.0.1:${halHttpPort}"
telemetry_interval_s = 1
state_dir = "${join(work, 'hal-state')}"
mdns = false

[dosing]
enabled = true
max_doses_per_day = 2

[[camera]]
name = "upper"
device = "/dev/video0"

[[sensor]]
kind = "pct2075"
addr = 0x48
[[sensor]]
kind = "ina219"
addr = 0x40
[[sensor]]
kind = "dht20"
addr = 0x38
[[sensor]]
kind = "dyp_a01"
trigger = 26
echo = 19
[[sensor]]
kind = "ezo_ph"
addr = 0x63

[[actuator]]
id = "light"
kind = "pwm_light"
pin = 18
[[actuator]]
id = "pump"
kind = "pwm_pump"
pin = 24
[[actuator]]
id = "dose_1"
kind = "dosing"
pin = 5
`)

// What a backup carries besides the database: the LAN broker's password file and its config.
const mosquittoDir = join(work, 'mosquitto')
mkdirSync(mosquittoDir)
writeFileSync(join(mosquittoDir, 'seedypod.passwd'), 'homeassistant:$7$101$bringup\n')
writeFileSync(join(mosquittoDir, 'seedypod.conf'), 'per_listener_settings true\nlistener 1883 127.0.0.1\nallow_anonymous true\n')

// A path-style S3 bucket in memory (no auth check): the mirror and nightly backups talk to it over HTTP.
const bucket = new Map()
const s3 = createHttpServer(async (req, res) => {
  const url = new URL(req.url, 'http://s3')
  const [, , ...rest] = url.pathname.split('/')
  const key = rest.map(decodeURIComponent).join('/')
  const body = []
  for await (const c of req) body.push(c)
  if (req.method === 'PUT') bucket.set(key, Buffer.concat(body))
  else if (req.method === 'DELETE') bucket.delete(key)
  else if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const prefix = url.searchParams.get('prefix') ?? ''
    const items = [...bucket].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>2026-10-31T03:00:00.000Z</LastModified><Size>${v.length}</Size></Contents>`)
    res.setHeader('content-type', 'application/xml')
    return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items.join('')}</ListBucketResult>`)
  }
  else if (req.method === 'GET') {
    if (!bucket.has(key)) {
      res.statusCode = 404
      return res.end('NoSuchKey')
    }
    return res.end(bucket.get(key))
  }
  res.statusCode = req.method === 'DELETE' ? 204 : 200
  res.end()
})
await new Promise(r => s3.listen(s3Port, '127.0.0.1', r))
const s3Config = { endpoint: `http://127.0.0.1:${s3Port}`, bucket: 'pods', region: 'auto', prefix: 'bringup/', accessKeyId: 'AK', secretAccessKey: 'SK' }

const broker = await Aedes.createBroker()
const brokerServer = createServer(broker.handle)
await new Promise(r => brokerServer.listen(brokerPort, '127.0.0.1', r))
const brokerUrl = `mqtt://127.0.0.1:${brokerPort}`

function start(cmd, args, env, tag) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  p.stdout.on('data', d => log.push(String(d)))
  p.stderr.on('data', d => log.push(String(d)))
  children.push({ p, log, tag })
  return p
}

const coreEnv = {
  PORT: String(corePort), HOST: '127.0.0.1', DATA_DIR: join(work, 'core'), CI: '',
  HAL_MQTT_URL: brokerUrl, HAL_UNIT_ID: unit, HAL_HTTP_URL: `http://127.0.0.1:${halHttpPort}`,
  // Backups and the real restore helper, pointed at this scratch unit; the helper's service
  // commands come back to this harness through tests/sim/fake-systemctl.mjs.
  SEEDYPOD_ETC_DIR: work, SEEDYPOD_STATE_DIR: join(work, 'hal-state'),
  SEEDYPOD_MOSQUITTO_PASSWD: join(mosquittoDir, 'seedypod.passwd'), SEEDYPOD_MOSQUITTO_CONF: join(mosquittoDir, 'seedypod.conf'),
  SEEDYPOD_RESTORE_CMD: JSON.stringify([process.execPath, join(root, 'scripts/seedypod-restore.cjs')]),
  SEEDYPOD_RESTORE_DB: join(work, 'core/seedypod.db'), SEEDYPOD_RESTORE_CAPTURES: join(work, 'core/captures'),
  SEEDYPOD_RESTORE_WORK: join(work, 'restore'), SEEDYPOD_RESTORE_DETACH: 'fork',
  SEEDYPOD_SYSTEMCTL: JSON.stringify([process.execPath, join(root, 'tests/sim/fake-systemctl.mjs')]),
  SIM_CONTROL_URL: `http://127.0.0.1:${controlPort}/`,
}
let daemon = null
let coreProc = null
const startHald = () => (daemon = start(hald, ['--sim', '--config', config, '--mqtt-url', brokerUrl], { RUST_LOG: 'info' }, 'hald'))
const startCore = () => (coreProc = start(process.execPath, [join(root, 'server/dist/index.js')], coreEnv, 'core'))
async function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode) return
  const gone = new Promise(r => p.once('exit', r))
  p.kill('SIGTERM')
  await Promise.race([gone, sleep(10_000).then(() => p.kill('SIGKILL'))])
  await gone
}
const services = { 'seedypod-core': { start: startCore, stop: () => stop(coreProc) }, 'hald': { start: startHald, stop: () => stop(daemon) } }
const systemctlCalls = []
const control = createHttpServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const [verb, name] = JSON.parse(body)
  systemctlCalls.push(`${verb} ${name}`)
  const svc = services[name]
  if (svc && verb === 'stop') await svc.stop()
  if (svc && verb === 'start') svc.start()
  res.end('ok')
})
await new Promise(r => control.listen(controlPort, '127.0.0.1', r))

// Minimal gzip'd ustar, to tamper with a downloaded bundle.
function untar(gz) {
  const t = gunzipSync(gz)
  const out = []
  for (let at = 0; at + 512 <= t.length;) {
    const h = t.subarray(at, at + 512)
    if (h.every(b => b === 0)) break
    const name = h.subarray(0, 100).toString().replace(/\0.*$/s, '')
    const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8)
    out.push({ name, bytes: Buffer.from(t.subarray(at + 512, at + 512 + size)) })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return out
}
function tar(entries) {
  const blocks = []
  for (const { name, bytes } of entries) {
    const h = Buffer.alloc(512)
    h.write(name, 0)
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write('0', 156)
    h.write('ustar\0', 257)
    h.write('00', 263)
    h.write(`${h.reduce((n, b) => n + b, 0).toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(h, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
const restoreStatus = () => {
  try {
    return JSON.parse(readFileSync(join(work, 'restore/status.json'), 'utf8'))
  }
  catch {
    return null
  }
}
/** Waits out a restore or undo: the helper restarts both services through the harness. */
async function afterRestart(op, since) {
  await until(`${op} to finish`, () => {
    const st = restoreStatus()
    if (st?.state === 'failed') throw new Error(`${op} failed: ${st.error}`)
    return st?.op === op && st.state === 'done' && st.at >= since
  }, 60_000)
  await until('core back', () => get('/healthcheck').then(h => h.ok), 30_000)
  await until('hald back', async () => (await get('/system')).halOnline, 30_000)
}

let exitCode = 1
try {
  await check('hald --check accepts the unit config', async () => {
    const r = spawnSync(hald, ['--sim', '--check', '--config', config], { encoding: 'utf8' })
    const out = JSON.parse(r.stdout)
    assert(r.status === 0 && out.ok, `exit ${r.status}: ${JSON.stringify(out.errors)}`)
    return `${out.sensors.length} sensors, ${out.actuators.join('/')}, cameras ${out.cameras.join('/')}`
  })

  const watcher = await mqtt.connectAsync(brokerUrl)
  const seen = new Map()
  watcher.on('message', (t, p) => seen.set(t, String(p)))
  await watcher.subscribeAsync(['homeassistant/#', `seedypod/${unit}/#`])

  startHald()
  startCore()
  await until('core to listen', () => get('/healthcheck').then(h => h.ok), 30_000)

  await check('core sees hald online with the unit\'s capabilities', async () => {
    const s = await until('system info over MQTT', async () => {
      const r = await get('/system')
      return r.halOnline && r.system ? r : null
    })
    assert(s.system.unitId === unit, `unitId ${s.system.unitId}`)
    for (const c of ['ph', 'water_distance', 'air_temp']) assert(s.system.caps.sensors.includes(c), `missing sensor ${c}`)
    assert(s.system.caps.actuators.includes('dose_1'), 'missing dose_1')
    return `${s.system.model}, limits ${JSON.stringify(s.system.limits)}`
  })

  await check('telemetry flows hald → MQTT → core', async () => {
    const s = await until('readings', async () => {
      const r = await get('/sensors')
      return r.air_temp && r.water_distance && r.ph ? r : null
    })
    return `air ${s.air_temp.value} ${s.air_temp.unit}, water ${s.water_distance.value} cm, pH ${s.ph.value}`
  })

  await check('Home Assistant discovery is published for every entity', async () => {
    const cfgs = await until('discovery', () => {
      const c = [...seen.keys()].filter(t => t.startsWith('homeassistant/') && t.endsWith('/config'))
      return c.length >= 10 ? c : null
    })
    for (const want of ['binary_sensor/sim-bringup_dose_fault', 'button/sim-bringup_ack_dose_fault', 'light/sim-bringup_light', 'fan/sim-bringup_pump'])
      assert(cfgs.some(t => t.includes(want)), `no ${want}`)
    return `${cfgs.length} entities`
  })

  await check('light: command round-trips through the daemon', async () => {
    const r = await post('/light', { on: true, level: 60 })
    assert(r.status === 200 && r.body.level === 60, `${r.status} ${JSON.stringify(r.body)}`)
    const st = JSON.parse(seen.get(`seedypod/${unit}/actuator/light/state`) ?? '{}')
    assert(st.level === 60, `hald state ${JSON.stringify(st)}`)
    return 'level 60 echoed'
  })

  await check('pump: duty clamped to the guard and run bounded', async () => {
    const r = await post('/pump/run-once', { durationS: 2, level: 100 })
    assert(r.status === 200 && r.body.on, `${r.status} ${JSON.stringify(r.body)}`)
    assert(r.body.level <= 30, `duty ${r.body.level} > 30`)
    await until('pump to stop on its own', async () => (await get('/pump')).on === false, 10_000)
    return `ran at ${r.body.level} %, stopped after its bound`
  })

  await check('camera: still fetched over hald HTTP and stored', async () => {
    const r = await post('/camera/upper/capture', {})
    assert(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`)
    const caps = await get('/captures')
    assert(caps.length >= 1, 'no capture stored')
    return `${caps.length} capture(s)`
  })

  await check('capture analysis runs every analyser on the worker thread', async () => {
    const [latest] = await get('/captures?limit=1')
    const rows = await until('analysis rows', async () => {
      const r = await get(`/vision/captures/${latest.id}`)
      return r.length > 0 ? r : null
    })
    const analyzers = [...new Set(rows.map(r => r.analyzer))].sort()
    assert(analyzers.join() === 'exg-otsu,green-threshold', `analysers ${analyzers}`)
    const status = await get('/vision/status')
    assert(status.failed === 0, `failed ${status.failed}`)
    return `${rows.length} rows from ${analyzers.join(' + ')}`
  })

  await check('dataset export streams a tar with the stills and results', async () => {
    const r = await fetch(`${api}/datasets/export`)
    assert(r.status === 200 && r.headers.get('content-type') === 'application/x-tar', `${r.status} ${r.headers.get('content-type')}`)
    const tar = join(work, 'dataset.tar')
    writeFileSync(tar, new Uint8Array(await r.arrayBuffer()))
    const list = spawnSync('tar', ['-tf', tar], { encoding: 'utf8' })
    assert(list.status === 0, list.stderr)
    const files = list.stdout.trim().split('\n')
    for (const want of ['manifest.json', 'captures.jsonl', 'analyses.jsonl', 'telemetry.jsonl', 'pods.json'])
      assert(files.some(f => f.endsWith(`/${want}`)), `no ${want}`)
    assert(files.some(f => /\/images\/upper-.*\.jpg$/.test(f)), 'no still')
    return `${files.length} files`
  })

  await check('an off-device worker posts results that sit beside the on-device ones', async () => {
    const off = await fetch(`${api}/analyses/results`, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer x' }, body: '{}' })
    assert(off.status === 404, `ingest without a token → ${off.status}`)
    const r = await fetch(`${api}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysisIngestToken: 'bringup-token' }) })
    assert(r.status === 200, `settings → ${r.status}`)
    const run = spawnSync(process.execPath, [join(root, 'scripts/analysis-worker.mjs'), '--id', 'exg-strict', '--limit', '5'], { encoding: 'utf8', env: { ...process.env, SEEDYPOD_URL: `http://127.0.0.1:${corePort}`, SEEDYPOD_INGEST_TOKEN: 'bringup-token' } })
    assert(run.status === 0, `worker exited ${run.status}: ${run.stderr || run.stdout}`)
    const remote = (await get('/vision/analyzers')).find(a => a.id === 'exg-strict')
    assert(remote?.source === 'remote' && remote.rows > 0, `analyzers ${JSON.stringify(remote)}`)
    const cmp = await get('/vision/compare/1')
    assert(cmp.some(s => s.analyzer === 'exg-strict') && cmp.some(s => s.analyzer === 'green-threshold'), 'not comparable on pod 1')
    return run.stdout.trim()
  })

  await check('EZO calibration reaches the probe; unknown probe refused', async () => {
    const ok = await post('/sensors/ph/calibrate', { point: 'mid', value: 7 })
    assert(ok.status === 200 && ok.body.ok && ok.body.points === 1, `${ok.status} ${JSON.stringify(ok.body)}`)
    const bad = await post('/sensors/ec/calibrate', { point: 'dry' })
    assert(bad.status === 412, `ec → ${bad.status}`)
    return 'ph mid → 1 point; ec → 412'
  })

  await check('dosing lockout raises dose_fault; acknowledge clears it', async () => {
    const dose = () => watcher.publishAsync(`seedypod/${unit}/actuator/dose_1/set`, JSON.stringify({ on: true, durationS: 1 }), { qos: 1 })
    for (let i = 0; i < 3; i++) {
      await dose()
      await sleep(1500)
    }
    const alert = await until('dose_fault in core', async () => (await get('/alerts')).find(a => a.kind === 'dose_fault' && a.active))
    assert(/dose_1/.test(alert.detail), `detail ${alert.detail}`)
    const pumpFault = (await get('/alerts')).find(a => a.kind === 'pump_fault' && a.active)
    assert(!pumpFault, 'pump_fault raised for a doser')
    const ack = await post(`/alerts/${alert.id}/acknowledge`, {})
    assert(ack.status === 200, `ack ${ack.status}`)
    await until('doser latch cleared in hald', () => JSON.parse(seen.get(`seedypod/${unit}/actuator/dose_1/state`) ?? '{}').fault === null)
    return `"${alert.detail}" → acknowledged`
  })

  await check('a probe added from the app goes live without restarting hald', async () => {
    const r = await post('/devices/sensors', { kind: 'ezo_ec', addr: 0x64 })
    assert(r.status === 200 && r.body.ok, `${r.status} ${JSON.stringify(r.body)}`)
    await until('EC readings', async () => (await get('/sensors')).ec)
    const inv = await get('/devices')
    assert(inv.sensors.some(d => d.kind === 'ezo_ec' && d.source === 'user' && d.status === 'ready'), 'not in inventory')
    assert(seen.has('homeassistant/sensor/sim-bringup_ec/config'), 'no HA entity')
    const stock = await fetch(`${api}/devices/sensors/ezo_ph/${0x63}`, { method: 'DELETE' })
    assert(stock.status === 412, `removing a hal.toml probe → ${stock.status}`)
    const del = await fetch(`${api}/devices/sensors/ezo_ec/${0x64}`, { method: 'DELETE' })
    assert(del.status === 200, `remove → ${del.status}`)
    await until('HA entity deleted', () => seen.get('homeassistant/sensor/sim-bringup_ec/config') === '')
    return 'added EC at 0x64 → readings + HA entity → removed; hal.toml probe refused'
  })

  await check('an armed Autopilot rule drives the light through hald; the kill switch releases it', async () => {
    const rule = {
      name: 'bring-up: light follows pH',
      dryRun: false,
      trigger: { kind: 'tick', everyMin: 1 },
      conditions: { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'sensor.ph' }, right: { kind: 'literal', value: 5 } },
      actions: [{ kind: 'setLight', level: { kind: 'literal', value: 35 } }],
    }
    // The light check above set the light by hand, which holds for 30 minutes; hand it back first.
    const resumed = await post('/light/resume', {})
    assert(resumed.status === 200 && resumed.body.source !== 'manual', `resume → ${resumed.status} ${JSON.stringify(resumed.body)}`)
    const created = await post('/automations', rule)
    assert(created.status === 200, `create → ${created.status} ${JSON.stringify(created.body)}`)
    await until('hald to report light 35', () => JSON.parse(seen.get(`seedypod/${unit}/actuator/light/state`) ?? '{}').level === 35)
    const owner = await get('/light/owner')
    assert(owner.source === 'autopilot', `owner ${JSON.stringify(owner)}`)
    const [run] = await get(`/automations/runs?automationId=${created.body.id}&limit=1`)
    assert(run?.outcome === 'fired', `run ${JSON.stringify(run)}`)
    const off = await fetch(`${api}/autopilot/enabled`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    assert(off.status === 200, `kill switch → ${off.status}`)
    await until('light released', async () => (await get('/light/owner')).source !== 'autopilot')
    return `rule ${created.body.id} fired → light 35 in hald → kill switch released it`
  })

  let download = null
  await check('backup: nightly upload to the bucket, and a download with hald\'s files', async () => {
    const set = await fetch(`${api}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      unitName: 'Bring-up tower', mirrorEndpoint: s3Config.endpoint, mirrorBucket: s3Config.bucket, mirrorPrefix: s3Config.prefix,
      mirrorAccessKeyId: s3Config.accessKeyId, mirrorSecretAccessKey: s3Config.secretAccessKey, setupComplete: true,
    }) })
    assert(set.status === 200, `settings → ${set.status}`)
    const sched = await fetch(`${api}/schedules/bringup-water`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'bringup-water', kind: 'pump', name: 'Bring-up watering', enabled: true, days: 127, spec: { minute: 480, durationS: 60 } }) })
    assert(sched.status === 200, `schedule → ${sched.status}`)
    assert((await post('/grow/start', { notes: 'bring-up basil' })).status === 200, 'grow start')
    const probe = await post('/devices/sensors', { kind: 'ezo_ec', addr: 0x64 })
    assert(probe.status === 200 && probe.body.ok, `probe → ${JSON.stringify(probe.body)}`)
    await until('sensors.json', () => existsSync(join(work, 'hal-state/sensors.json')))
    const run = await post('/backup/run', {})
    assert(run.status === 200 && run.body.ok, `backup → ${run.status} ${JSON.stringify(run.body)}`)
    const listed = await get('/backup/bucket')
    assert(listed.length === 1 && listed[0].key.startsWith('backups/seedypod-backup-sim-bringup-'), `bucket ${JSON.stringify(listed)}`)
    assert(bucket.has(`bringup/${listed[0].key}`), 'not under the mirror prefix')
    const d = await fetch(`${api}/backup/download`)
    assert(d.status === 200, `download → ${d.status}`)
    download = Buffer.from(await d.arrayBuffer())
    const names = untar(download).map(e => e.name)
    for (const want of ['seedypod.db', 'etc/seedypod/hal.toml', 'etc/mosquitto/seedypod.passwd', 'var/lib/seedypod/sensors.json', 'manifest.json'])
      assert(names.includes(want), `bundle has no ${want}: ${names}`)
    return `${listed[0].name} (${run.body.bytes} B) in the bucket; download has ${names.length} files`
  })

  await check('restore: wipe the card, Welcome offers Restore, the bucket backup brings the unit back', async () => {
    // A new card: no database, no hald state, no broker password, a stock hal.toml.
    await services['seedypod-core'].stop()
    await services.hald.stop()
    for (const d of ['core', 'hal-state', 'restore']) rmSync(join(work, d), { recursive: true, force: true })
    rmSync(join(mosquittoDir, 'seedypod.passwd'), { force: true })
    writeFileSync(join(mosquittoDir, 'seedypod.conf'), 'per_listener_settings true\nlistener 1883 127.0.0.1\nallow_anonymous true\n')
    const halToml = readFileSync(config, 'utf8')
    writeFileSync(config, `# fresh card\n${halToml}`)
    startHald()
    startCore()
    await until('fresh core', () => get('/healthcheck').then(h => h.ok), 30_000)
    const fresh = await get('/settings')
    assert(fresh.setupComplete === false && fresh.unitName === 'Gardyn', `fresh unit ${JSON.stringify({ setupComplete: fresh.setupComplete, unitName: fresh.unitName })}`)
    assert((await get('/backup/restore')).available, 'restore not available')

    const browse = await post('/backup/browse', { config: s3Config })
    assert(browse.status === 200 && browse.body.length === 1, `browse → ${browse.status} ${JSON.stringify(browse.body)}`)
    systemctlCalls.length = 0
    const since = new Date().toISOString()
    const r = await post('/backup/restore-from-bucket', { key: browse.body[0].key, config: s3Config })
    assert(r.status === 200 && r.body.restarting, `restore → ${r.status} ${JSON.stringify(r.body)}`)
    await afterRestart('restore', since)
    assert(systemctlCalls.join(',') === 'stop seedypod-core,stop hald,try-restart mosquitto,start hald,start seedypod-core', `services ${systemctlCalls}`)

    const s = await get('/settings')
    assert(s.unitName === 'Bring-up tower' && s.setupComplete === true && s.mirrorBucket === 'pods', `settings ${JSON.stringify({ unitName: s.unitName, setupComplete: s.setupComplete })}`)
    assert((await get('/schedules')).some(x => x.id === 'bringup-water'), 'schedule missing')
    assert((await get('/grow')).cycle?.notes === 'bring-up basil', 'grow cycle missing')
    assert((await get('/automations')).some(a => a.name === 'bring-up: light follows pH'), 'Autopilot rule missing')
    await until('the app-added EC probe back in hald', async () => (await get('/devices')).sensors.some(d => d.kind === 'ezo_ec' && d.source === 'user'), 20_000)
    assert(!readFileSync(config, 'utf8').startsWith('# fresh card'), 'hal.toml not restored')
    assert(readFileSync(join(mosquittoDir, 'seedypod.passwd'), 'utf8').startsWith('homeassistant:'), 'broker password not restored')
    assert(/^listener 1884$/m.test(readFileSync(join(mosquittoDir, 'seedypod.conf'), 'utf8')), 'LAN listener not written')
    return 'settings, schedule, grow cycle, Autopilot rule, EC probe, hal.toml and broker password are back'
  })

  await check('restore refuses a backup from newer software and leaves the unit alone', async () => {
    const tampered = untar(download).map((e) => {
      if (e.name !== 'manifest.json') return e
      const m = JSON.parse(e.bytes)
      return { name: e.name, bytes: Buffer.from(JSON.stringify({ ...m, schema: { ...m.schema, migrations: m.schema.migrations + 1 }, core: { version: 'main@future1' } })) }
    })
    const r = await fetch(`${api}/backup/restore`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: tar(tampered) })
    const body = await r.json()
    assert(r.status === 409 && body.code === 'newer-schema', `→ ${r.status} ${JSON.stringify(body)}`)
    assert(/made by seedypod core main@future1 .*Install that version of core or newer first/.test(body.error), body.error)
    assert((await get('/settings')).unitName === 'Bring-up tower', 'unit changed')
    return body.error
  })

  await check('a wrong restore can be undone, and redone', async () => {
    let since = new Date().toISOString()
    const u = await post('/backup/undo', {})
    assert(u.status === 200, `undo → ${u.status} ${JSON.stringify(u.body)}`)
    await afterRestart('undo', since)
    const back = await get('/settings')
    assert(back.unitName === 'Gardyn' && back.setupComplete === false, `after undo ${back.unitName}`)
    assert(readFileSync(config, 'utf8').startsWith('# fresh card'), 'hal.toml not put back')
    assert(!existsSync(join(mosquittoDir, 'seedypod.passwd')), 'password file not put back')
    since = new Date().toISOString()
    assert((await post('/backup/undo', {})).status === 200, 'redo')
    await afterRestart('undo', since)
    assert((await get('/settings')).unitName === 'Bring-up tower', 'redo did not bring the restore back')
    const info = await get('/backup/restore')
    assert(info.undo?.undoneAt === null && info.status?.state === 'done', `info ${JSON.stringify(info)}`)
    return 'undo → fresh card again; undo again → restored'
  })

  await check('daemon loss is noticed (LWT → hal_offline)', async () => {
    daemon.kill('SIGKILL')
    // Without a clean disconnect the broker fires the will after the keep-alive lapses.
    const a = await until('hal_offline', async () => (await get('/alerts')).find(x => x.kind === 'hal_offline' && x.active), 60_000)
    return a.detail
  })

  await watcher.endAsync()
  exitCode = results.every(r => r.ok) ? 0 : 1
}
catch (e) {
  results.push({ name: 'harness', ok: false, detail: e.message })
}
finally {
  for (const { p } of children) p.kill('SIGKILL')
  await new Promise(r => brokerServer.close(r))
  s3.close()
  control.close()
  broker.close()
  const w = Math.max(...results.map(r => r.name.length))
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(w)}  ${r.detail}`)
  if (exitCode !== 0) {
    for (const { tag, log } of children) console.log(`\n--- ${tag} log (tail) ---\n${log.join('').split('\n').slice(-40).join('\n')}`)
  }
  rmSync(work, { recursive: true, force: true })
  process.exit(exitCode)
}
