/**
 * The live facts beside the SSH login logo: login-stats against a fake core
 * (an HTTP server here) and a fake /proc and /sys, then login-logo drawing them
 * on a real pseudo-terminal (tests/scripts/pty-run.py).
 */
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000 })
const run = promisify(execFile)

const repo = resolve(import.meta.dirname, '../..')
const source = join(repo, 'scripts/login-logo')
// eslint-disable-next-line no-control-regex
const ESC = /\x1b/

const SUMMARY = {
  coreVersion: 'dev@081abf0',
  unitId: 'gardyn-db753a85', model: 'gardyn 3.0', halOnline: true,
  lightOn: true, lightLevel: 80, lightFault: false,
  pumpOn: false, pumpRemainingS: null, pumpFault: false,
  tankPct: 18.17, airC: 26.2, humidityPct: 50.4, boardC: 36,
  readingAgeS: 4, staleSensors: 1, activeAlerts: 2, captureAgeS: 2640,
  visionRunner: 'podvision', visionFallback: false, podStateModels: 1,
  updateState: 'available', updateTo: 'dev@aed156b', updateCheckedAgeS: 7200,
}

let dir: string
let share: string
let root: string
let bin: string
let server: Server
let port: number
/** What the fake core does with the next request. */
let core: { status: number, body: unknown, hang?: boolean, requests: string[] }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'login-stats-'))
  share = join(dir, 'share')
  root = join(dir, 'root')
  bin = join(dir, 'bin')
  for (const d of [share, root, bin]) mkdirSync(d)
  for (const f of ['login-logo', 'login-stats']) copyFileSync(join(source, f), join(share, f))
  chmodSync(join(share, 'login-stats'), 0o755)
  writeFileSync(join(share, 'logo.frames'), readFileSync(join(source, 'logo.frames'), 'utf8').split('\n').slice(0, 6).join('\n'))
  writeFileSync(join(share, 'version'), 'dev@abc1234\n')
  files({
    'proc/uptime': '162180.55 150000.00\n',
    'proc/loadavg': '2.10 2.08 1.60 4/121 12438\n',
    'proc/meminfo': 'MemTotal:         437120 kB\nMemFree:           39000 kB\nMemAvailable:     190944 kB\n',
    'sys/class/thermal/thermal_zone0/temp': '49768\n',
    'sys/fs/cgroup/system.slice/hald.service/cgroup.procs': '423\n',
    'sys/fs/cgroup/system.slice/seedypod-core.service/cgroup.procs': '11433\n',
  })
  stub('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/mmcblk0p2 60809268 2200584 56097604 4% /"')
  stub('vcgencmd', '[ "$1" = get_throttled ] && echo throttled=0x0')
  core = { status: 200, body: SUMMARY, requests: [] }
  server = createServer((req, res) => {
    core.requests.push(`${req.method} ${req.url}`)
    if (core.hang) return
    res.writeHead(core.status, { 'content-type': 'application/json' }).end(JSON.stringify(core.body))
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  port = (server.address() as AddressInfo).port
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise(ok => server.close(ok))
  rmSync(dir, { recursive: true, force: true })
})

function files(f: Record<string, string>) {
  for (const [path, text] of Object.entries(f)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}
function stub(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}
const env = (extra: Record<string, string | undefined> = {}) => ({
  PATH: `${bin}:${process.env.PATH}`, HOME: dir, HOSTNAME: 'seedypod.lan', LANG: 'en_GB.UTF-8',
  SEEDYPOD_API: `127.0.0.1:${port}`, SEEDYPOD_STATS_ROOT: root, SSH_CONNECTION: '192.168.1.117 58442 192.168.2.177 22', ...extra,
})

/** Generous deadlines, so that a loaded test machine doesn't cut the facts short. */
const SLOW = { SEEDYPOD_API_MS: '5000', SEEDYPOD_STATS_MS: '8000' }

async function stats(extra: Record<string, string | undefined> = SLOW) {
  const started = Date.now()
  const r = await run('bash', [join(share, 'login-stats')], { env: env(extra), encoding: 'utf8' })
  return { facts: r.stdout.trimEnd().split('\n').filter(Boolean).map(l => l.split('\t')), err: r.stderr, ms: Date.now() - started }
}

describe('login-stats', () => {
  it('asks core once and lists every fact, in order', async () => {
    const r = await stats()
    expect(core.requests).toEqual(['GET /api/system/login-summary'])
    expect(r.err).toBe('')
    expect(r.facts).toEqual([
      ['version', '-:dev@081abf0'],
      ['unit', '-:gardyn-db753a85', 'dim:gardyn 3.0'],
      ['web', '-:http://192.168.2.177:3000'],
      ['status', 'ok:core up', 'ok:hald up'],
      ['update', 'warn:dev@aed156b available', 'dim:checked 2h ago', 'dim:sudo seedypod-update --now'],
      ['uptime', '-:1d 21h', 'dim:load 2.10'],
      ['outputs', 'ok:light on 80%', '-:pump off'],
      ['tank', '-:18%'],
      ['air', '-:26.2°C', '-:50% RH'],
      ['board', '-:36°C', '-:cpu 50°C'],
      ['camera', '-:44m ago'],
      ['vision', 'ok:podvision', 'dim:1 model'],
      ['sensors', '-:4s ago', 'warn:1 stale'],
      ['alerts', 'warn:2 active'],
      ['ram', 'bar-ok:56', '-:56% 240M/426M'],
      ['disk', 'bar-ok:4', '-:4% 2.0G/57.9G'],
      ['power', 'ok:ok'],
    ])
  })

  it('says where pod-state runs, and when podvision fell back to TypeScript', async () => {
    core.body = { ...SUMMARY, visionFallback: true, podStateModels: 2 }
    expect((await stats()).facts).toContainEqual(['vision', 'warn:fell back to TypeScript', 'dim:2 models'])
    core.body = { ...SUMMARY, visionRunner: 'typescript', podStateModels: 0 }
    expect((await stats()).facts).toContainEqual(['vision', '-:TypeScript', 'dim:no model'])
    core.body = { ...SUMMARY, podStateModels: null }
    expect((await stats()).facts).toContainEqual(['vision', 'ok:podvision'])
  })

  it('says what the last update check found, and how to act on it', async () => {
    core.body = { ...SUMMARY, updateState: 'current', updateTo: null }
    expect((await stats()).facts).toContainEqual(['update', 'ok:up to date', 'dim:checked 2h ago'])
    core.body = { ...SUMMARY, updateState: 'unchecked', updateTo: null, updateCheckedAgeS: null }
    expect((await stats()).facts).toContainEqual(['update', '-:not checked', 'dim:sudo seedypod-update --check'])
    core.body = { ...SUMMARY, updateState: null, updateTo: null, updateCheckedAgeS: null }
    expect((await stats()).facts.map(f => f[0])).not.toContain('update')
  })

  it('drops the port when port 80 forwards to core, and brackets IPv6', async () => {
    writeFileSync(join(share, 'port80.nft'), '')
    expect((await stats()).facts).toContainEqual(['web', '-:http://192.168.2.177'])
    expect((await stats({ SSH_CONNECTION: 'fe80::1 58442 fd00::7 22' })).facts).toContainEqual(['web', '-:http://[fd00::7]'])
  })

  it('writes plain C outside a UTF-8 locale', async () => {
    expect((await stats({ LANG: 'C' })).facts).toContainEqual(['air', '-:26.2C', '-:50% RH'])
  })

  it('flags faults, a running pump, a stale sensor feed and no alerts', async () => {
    core.body = { ...SUMMARY, lightFault: true, pumpOn: true, pumpRemainingS: 42, readingAgeS: 1200, staleSensors: 0, activeAlerts: 0 }
    const { facts } = await stats()
    expect(facts).toContainEqual(['outputs', 'bad:light fault', 'ok:pump running', 'dim:42s left'])
    expect(facts).toContainEqual(['sensors', 'warn:20m ago'])
    expect(facts).toContainEqual(['alerts', 'ok:none'])
    core.body = { ...SUMMARY, pumpFault: true, lightOn: false }
    expect((await stats()).facts).toContainEqual(['outputs', '-:light off', 'bad:pump fault'])
  })

  it('warns about a hot Pi, low memory, a filling card and power trouble', async () => {
    files({ 'sys/class/thermal/thermal_zone0/temp': '81200\n', 'proc/meminfo': 'MemTotal: 437120 kB\nMemAvailable: 30000 kB\n' })
    stub('df', 'echo h; echo "/dev/root 1000000 950000 40000 96% /"')
    stub('vcgencmd', 'echo throttled=0x50005')
    const { facts } = await stats()
    expect(facts).toContainEqual(['board', '-:36°C', 'bad:cpu 81°C'])
    expect(facts).toContainEqual(['ram', 'bar-warn:93', 'warn:93% 397M/426M'])
    expect(facts).toContainEqual(['disk', 'bar-bad:96', 'bad:96% 927M/976M'])
    expect(facts).toContainEqual(['power', 'bad:under-voltage'])
    stub('vcgencmd', 'echo throttled=0x50000')
    expect((await stats()).facts).toContainEqual(['power', 'warn:under-voltage since boot'])
  })

  it('still says what it can from the Pi while core is down, quickly', async () => {
    server.closeAllConnections()
    await new Promise(ok => server.close(ok))
    rmSync(join(root, 'sys/fs/cgroup/system.slice/seedypod-core.service'), { recursive: true })
    const r = await stats()
    expect(r.err).toBe('')
    expect(r.facts.map(f => f[0])).toEqual(['web', 'status', 'uptime', 'board', 'ram', 'disk', 'power'])
    expect(r.facts).toContainEqual(['status', 'bad:core down', 'ok:hald up'])
    // A refused connection doesn't wait out the deadline.
    expect(r.ms).toBeLessThan(4000)
    server = createServer()
  })

  it('gives up on a core that doesn\'t answer after 0.6 s', async () => {
    core.hang = true
    const r = await stats({})
    expect(r.facts).toContainEqual(['status', 'warn:core not answering', 'ok:hald up'])
    expect(r.facts.map(f => f[0])).not.toContain('tank')
    expect(r.ms).toBeGreaterThan(550)
  })

  it('ignores an error from core, and a hald core can\'t reach', async () => {
    core.status = 404
    core.body = { message: 'Not found' }
    expect((await stats()).facts).toContainEqual(['status', 'warn:core not answering', 'ok:hald up'])
    core.status = 200
    core.body = { ...SUMMARY, halOnline: false }
    expect((await stats()).facts).toContainEqual(['status', 'ok:core up', 'warn:hald not connected'])
    rmSync(join(root, 'sys/fs/cgroup/system.slice/hald.service'), { recursive: true })
    expect((await stats()).facts).toContainEqual(['status', 'ok:core up', 'bad:hald down'])
  })

  it('leaves out what it has no source for, off a Pi', async () => {
    rmSync(root, { recursive: true })
    rmSync(join(bin, 'vcgencmd'))
    core.body = { ...SUMMARY, unitId: null, tankPct: null, captureAgeS: null, airC: null, humidityPct: null }
    const { facts } = await stats({ SSH_CONNECTION: undefined })
    expect(facts.map(f => f[0])).toEqual(['version', 'status', 'update', 'outputs', 'board', 'vision', 'sensors', 'alerts', 'disk'])
    expect(facts).toContainEqual(['status', 'ok:core up', 'ok:hald up'])
    expect(facts).toContainEqual(['board', '-:36°C'])
  })
})

describe('login-logo with login-stats', () => {
  async function pty(spec: { env?: Record<string, string | undefined>, rows?: number, cols?: number } = {}) {
    const r = await run('python3', [join(repo, 'tests/scripts/pty-run.py'), JSON.stringify({ argv: ['bash', join(share, 'login-logo')], rows: spec.rows, cols: spec.cols, env: env({ TERM: 'xterm-kitty', ...SLOW, ...spec.env }) })], { encoding: 'utf8' })
    const { output, status, ms } = JSON.parse(r.stdout) as { output: string, status: number, ms: number }
    return { out: Buffer.from(output, 'base64').toString('utf8'), status, ms }
  }

  it('writes the word, version and address from the logo\'s top row, the facts under them', async () => {
    const r = await pty({ rows: 40 })
    expect(r.status).toBe(0)
    // The word is in the frame's top row; the version goes one row down.
    expect(r.out).toContain('\x1b[1B\r\x1b[46C\x1b[38;5;245mdev@081abf0')
    const after = r.out.slice(r.out.indexOf('http://seedypod.local:3000'))
    expect(after).toContain('\x1b[0m\r\n\r\n\r\x1b[46C\x1b[38;5;72munit    \x1b[0mgardyn-db753a85\r\n')
    expect(after).toContain('\x1b[38;5;72mstatus  \x1b[0m\x1b[38;5;114mcore up\x1b[0m\x1b[38;5;245m · \x1b[0m\x1b[38;5;114mhald up\x1b[0m')
    expect(after).toContain('\x1b[38;5;221m2 active\x1b[0m')
    // Sixteen facts on rows 4 to 19 fit beside the 20-row logo: back to its corner, then below it.
    expect(after.endsWith('power   \x1b[0m\x1b[38;5;114mok\x1b[0m\r\x1b[19A\x1b[20B\r\r\n\x1b[0m\x1b[?25h')).toBe(true)
  })

  it('carries on past the bottom of the logo when there are more facts than rows', async () => {
    writeFileSync(join(share, 'login-stats'), `#!/bin/sh\nfor i in $(seq 20); do printf "f$i\\t-:x\\n"; done\n`)
    const r = await pty({ rows: 40 })
    // Rows 4 to 23: no jump back to the logo's corner.
    expect(r.out.endsWith('f20     \x1b[0mx\r\n\r\r\n\x1b[0m\x1b[?25h')).toBe(true)
  })

  it('draws ram and disk as bars, shaded by how full they are', async () => {
    const r = await pty({ cols: 140 })
    expect(r.out).toContain('\x1b[38;5;72mram     \x1b[0m[\x1b[38;5;29m██\x1b[38;5;35m██\x1b[38;5;78m█\x1b[38;5;114m█\x1b[38;5;240m░░░░\x1b[0m] 56% 240M/426M\r\n')
    expect(r.out).toContain('\x1b[38;5;72mdisk    \x1b[0m[\x1b[38;5;240m░░░░░░░░░░\x1b[0m] 4% 2.0G/57.9G\r\n')
    files({ 'proc/meminfo': 'MemTotal: 437120 kB\nMemAvailable: 30000 kB\n' })
    stub('df', 'echo h; echo "/dev/root 1000000 950000 40000 96% /"')
    const low = await pty({ cols: 140 })
    expect(low.out).toContain('[\x1b[38;5;172m███\x1b[38;5;214m███\x1b[38;5;220m██\x1b[38;5;222m█\x1b[38;5;240m░\x1b[0m] \x1b[38;5;221m93% 397M/426M\x1b[0m')
    expect(low.out).toContain('[\x1b[38;5;167m███\x1b[38;5;203m███\x1b[38;5;209m███\x1b[38;5;216m█\x1b[0m] \x1b[38;5;203m96% 927M/976M\x1b[0m')
  })

  it('narrows the bars to make room, then leaves them out', async () => {
    const at = async (cols: number) => (await pty({ cols, env: { NO_COLOR: '1' } })).out.split('\r\n').filter(l => /^(ram|disk) /.test(l))
    // 80 columns leaves 33 beside the logo.
    expect((await pty()).out).toContain('ram     \x1b[0m[\x1b[38;5;29m██\x1b[38;5;35m█\x1b[38;5;78m█\x1b[38;5;114m█\x1b[38;5;240m░░░░\x1b[0m] 56% 240M/426M')
    expect(await at(30)).toEqual(['ram     [███░░░] 56% 240M/426M', 'disk    [░░░░░░] 4% 2.0G/57.9G'])
    expect(await at(24)).toEqual(['ram     56% 240M/426M', 'disk    4% 2.0G/57.9G'])
    expect((await pty({ cols: 30, env: { LANG: 'C' } })).out).toContain('ram     [###---] 56% 240M/426M')
  })

  it('prints the version core runs, not the file a web update left behind', async () => {
    const r = await pty()
    expect(r.out).toContain('\x1b[46C\x1b[38;5;245mdev@081abf0')
    expect(r.out).not.toContain('dev@abc1234')
  })

  it('goes back to the logo\'s corner when the facts fit beside it', async () => {
    rmSync(root, { recursive: true })
    core.body = { halOnline: true }
    const r = await pty({ env: { SSH_CONNECTION: undefined } })
    expect(r.out).toContain('\x1b[38;5;72mstatus  \x1b[0m')
    // status, disk and power: rows 4 to 6.
    expect(r.out.endsWith('\r\x1b[6A\x1b[20B\r\r\n\x1b[0m\x1b[?25h')).toBe(true)
  })

  it('cuts what doesn\'t fit at 80 columns', async () => {
    const r = await pty()
    expect(r.out).toContain('gardyn-db753a85\r\n')
    expect(r.out).not.toContain('gardyn 3.0')
  })

  it('lists them plain under the line with NO_COLOR, without an escape', async () => {
    const r = await pty({ env: { NO_COLOR: '1' } })
    expect(r.out).not.toMatch(ESC)
    expect(r.out.split('\r\n')).toEqual([
      'seedypod dev@081abf0  http://seedypod.local:3000',
      'unit    gardyn-db753a85 · gardyn 3.0',
      'web     http://192.168.2.177:3000',
      'status  core up · hald up',
      'update  dev@aed156b available · checked 2h ago · sudo seedypod-update --now',
      'uptime  1d 21h · load 2.10',
      'outputs light on 80% · pump off',
      'tank    18%',
      'air     26.2°C · 50% RH',
      'board   36°C · cpu 50°C',
      'camera  44m ago',
      'vision  podvision · 1 model',
      'sensors 4s ago · 1 stale',
      'alerts  2 active',
      'ram     [██████░░░░] 56% 240M/426M',
      'disk    [░░░░░░░░░░] 4% 2.0G/57.9G',
      'power   ok',
      '',
    ])
  })

  it('still opens quickly, without errors, when core is down', async () => {
    server.closeAllConnections()
    await new Promise(ok => server.close(ok))
    const r = await pty({ env: { NO_COLOR: '1' } })
    // The version file stands in for core's answer.
    expect(r.out).toMatch(/^seedypod dev@abc1234 {2}http:\/\/seedypod\.local:3000\r\nweb {5}http/)
    expect(r.out).not.toContain('tank')
    expect(r.ms).toBeLessThan(4000)
    server = createServer()
  })

  it('stops waiting a second in, keeping what login-stats had said', async () => {
    writeFileSync(join(share, 'login-stats'), '#!/bin/sh\nprintf "tank\\t-:18%%\\n"\nsleep 5\nprintf "late\\t-:never\\n"\n')
    const r = await pty({ env: { NO_COLOR: '1', SEEDYPOD_STATS_MS: undefined } })
    expect(r.out).toBe('seedypod dev@abc1234  http://seedypod.local:3000\r\ntank    18%\r\n')
    expect(r.ms).toBeGreaterThan(900)
    expect(r.ms).toBeLessThan(4000)
  })

  it('is left out with the rest of the logo by SEEDYPOD_NO_LOGO=1', async () => {
    expect((await pty({ env: { SEEDYPOD_NO_LOGO: '1' } })).out).toBe('')
    expect(core.requests).toEqual([])
  })
})
