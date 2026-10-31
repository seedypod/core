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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const [brokerPort, halHttpPort, corePort] = [await freePort(), await freePort(), await freePort()]
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

  const daemon = start(hald, ['--sim', '--config', config, '--mqtt-url', brokerUrl], { RUST_LOG: 'info' }, 'hald')
  start(process.execPath, [join(root, 'server/dist/index.js')], {
    PORT: String(corePort), HOST: '127.0.0.1', DATA_DIR: join(work, 'core'), CI: '',
    HAL_MQTT_URL: brokerUrl, HAL_UNIT_ID: unit, HAL_HTTP_URL: `http://127.0.0.1:${halHttpPort}`,
  }, 'core')
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
  broker.close()
  const w = Math.max(...results.map(r => r.name.length))
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(w)}  ${r.detail}`)
  if (exitCode !== 0) {
    for (const { tag, log } of children) console.log(`\n--- ${tag} log (tail) ---\n${log.join('').split('\n').slice(-40).join('\n')}`)
  }
  rmSync(work, { recursive: true, force: true })
  process.exit(exitCode)
}
