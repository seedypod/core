#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// seedypod restore helper (ADR-0021). Installed root-owned at
// /usr/local/sbin/seedypod-restore by scripts/install, which writes the
// install prefix in and lets core's user run it with sudo, for this one path.
// Node built-ins only; it must not load anything the core user can write.
//
// Usage: seedypod-restore <bundle.tar.gz>     check the bundle, then restore it
//        seedypod-restore --detach <bundle>   check, then restore in its own unit (what core calls)
//        seedypod-restore --check <bundle>    check only
//        seedypod-restore --undo [--detach]   put back what the last restore replaced (again to redo)
//        seedypod-restore --status            print the last run's status
// Exit codes: 0 ok, 1 failed, 2 usage, 3 refused (bundle from a newer schema), 4 not a valid bundle.
// The last line of stdout is a JSON result for core.
'use strict'

const { execFileSync, spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const INSTALLED_PREFIX = '__PREFIX__'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
// Overrides exist for tests and the simulated bring-up; as root (under sudo) only the installed paths count.
const env = name => (isRoot ? undefined : process.env[name]) || undefined
const prefix = INSTALLED_PREFIX.startsWith('__') ? path.resolve(__dirname, '..') : INSTALLED_PREFIX

const P = {
  db: env('SEEDYPOD_RESTORE_DB') ?? path.join(prefix, 'data/seedypod.db'),
  captures: env('SEEDYPOD_RESTORE_CAPTURES') ?? path.join(prefix, 'data/captures'),
  journal: env('SEEDYPOD_RESTORE_JOURNAL') ?? path.join(prefix, 'src/db/migrations/meta/_journal.json'),
  etc: env('SEEDYPOD_ETC_DIR') ?? '/etc/seedypod',
  state: env('SEEDYPOD_STATE_DIR') ?? '/var/lib/seedypod',
  passwd: env('SEEDYPOD_MOSQUITTO_PASSWD') ?? '/etc/mosquitto/seedypod.passwd',
  mosquittoConf: env('SEEDYPOD_MOSQUITTO_CONF') ?? '/etc/mosquitto/conf.d/seedypod.conf',
  work: env('SEEDYPOD_RESTORE_WORK') ?? '/var/lib/seedypod-restore',
}
const STAGING = path.join(P.work, 'staging')
const PRE = path.join(P.work, 'pre-restore')
const UNDO_INFO = path.join(P.work, 'undo.json')
const STATUS = path.join(P.work, 'status.json')

/** Archive names this helper accepts; keep in step with BUNDLE_NAMES in src/backup/bundle.ts. */
const NAMES = [
  /^manifest\.json$/,
  /^seedypod\.db$/,
  /^etc\/seedypod\/hal\.toml$/,
  /^etc\/mosquitto\/seedypod\.passwd$/,
  /^var\/lib\/seedypod\/[a-z0-9_-]+\.json$/,
  /^captures\/(?:[\w-][\w.@-]*\/)*[\w-][\w.@-]*$/,
]

class Refused extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---- reading a bundle ----------------------------------------------------------

/** Streams a gzip'd ustar into `dir`, refusing anything but regular files with known names. */
async function extract(bundle, dir) {
  const names = []
  const input = fs.createReadStream(bundle).pipe(zlib.createGunzip())
  let buf = Buffer.alloc(0)
  let phase = 'header'
  let fd = null
  let remaining = 0
  let pad = 0
  let ended = false
  try {
    for await (const chunk of input) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      for (;;) {
        if (phase === 'header') {
          if (buf.length < 512) break
          const h = buf.subarray(0, 512)
          buf = buf.subarray(512)
          if (h.every(b => b === 0)) {
            ended = true
            break
          }
          const e = parseHeader(h)
          remaining = e.size
          pad = (512 - (e.size % 512)) % 512
          if (e.type === '5') {
            if (e.size !== 0) throw new Refused('invalid', `directory entry ${e.name} has data`)
            phase = 'pad'
            continue
          }
          if (e.type !== '0' && e.type !== '\0') throw new Refused('invalid', `${e.name} is not a regular file (tar type ${JSON.stringify(e.type)})`)
          if (!NAMES.some(re => re.test(e.name))) throw new Refused('invalid', `unexpected file in the bundle: ${e.name}`)
          if (names.includes(e.name)) throw new Refused('invalid', `${e.name} appears twice`)
          names.push(e.name)
          const out = path.join(dir, e.name)
          fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
          fd = fs.openSync(out, 'wx', 0o600)
          phase = 'data'
        }
        if (phase === 'data') {
          const take = Math.min(remaining, buf.length)
          if (take) fs.writeSync(fd, buf, 0, take)
          remaining -= take
          buf = buf.subarray(take)
          if (remaining > 0) break
          fs.closeSync(fd)
          fd = null
          phase = 'pad'
        }
        if (phase === 'pad') {
          if (buf.length < pad) {
            pad -= buf.length
            buf = Buffer.alloc(0)
            break
          }
          buf = buf.subarray(pad)
          pad = 0
          phase = 'header'
        }
      }
      if (ended) break
    }
  }
  catch (e) {
    if (e instanceof Refused) throw e
    throw new Refused('invalid', `not a seedypod backup (${e.message})`)
  }
  finally {
    if (fd !== null) fs.closeSync(fd)
    input.destroy()
  }
  if (!ended && (phase !== 'header' || buf.length)) throw new Refused('invalid', 'the bundle is cut short')
  return names
}

function parseHeader(h) {
  const str = (at, len) => h.subarray(at, at + len).toString('utf8').replace(/\0.*$/s, '')
  const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0)
  if (sum !== parseInt(str(148, 8).trim(), 8)) throw new Refused('invalid', 'not a seedypod backup (bad tar header checksum)')
  if (str(345, 155)) throw new Refused('invalid', 'unexpected long path in the bundle')
  const name = str(0, 100).replace(/\/$/, '')
  const size = parseInt(str(124, 12).trim() || '0', 8)
  if (!Number.isSafeInteger(size) || size < 0) throw new Refused('invalid', `bad size for ${name}`)
  return { name, size, type: String.fromCharCode(h[156]) }
}

function sha256(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.alloc(1 << 20)
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n))
  }
  finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function installedSchema() {
  const journal = JSON.parse(fs.readFileSync(P.journal, 'utf8'))
  return { migrations: journal.entries.length, tag: journal.entries.at(-1)?.tag ?? null }
}

/** Checks the staged files against the staged manifest. Returns the manifest. */
function verify(dir, names) {
  const mpath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(mpath)) throw new Refused('invalid', 'the bundle has no manifest.json')
  let m
  try {
    m = JSON.parse(fs.readFileSync(mpath, 'utf8'))
  }
  catch {
    throw new Refused('invalid', 'manifest.json is not valid JSON')
  }
  if (m?.format?.name !== 'seedypod-backup') throw new Refused('invalid', 'not a seedypod backup (manifest format)')
  if (m.format.version !== 1) throw new Refused('invalid', `backup format version ${m.format.version} is not supported here; update core first`)
  if (!m.files || typeof m.files !== 'object' || !Number.isInteger(m.schema?.migrations)) throw new Refused('invalid', 'manifest.json is incomplete')
  const listed = Object.keys(m.files)
  const staged = names.filter(n => n !== 'manifest.json')
  for (const n of staged) if (!listed.includes(n)) throw new Refused('invalid', `${n} is not in the manifest`)
  for (const n of listed) {
    if (!staged.includes(n)) throw new Refused('invalid', `${n} is missing from the bundle`)
    const f = path.join(dir, n)
    if (fs.statSync(f).size !== m.files[n].bytes || sha256(f) !== m.files[n].sha256) throw new Refused('invalid', `${n} doesn't match its checksum; the file is damaged`)
  }
  if (!staged.includes('seedypod.db')) throw new Refused('invalid', 'the bundle has no database')
  const head = Buffer.alloc(16)
  const fd = fs.openSync(path.join(dir, 'seedypod.db'), 'r')
  fs.readSync(fd, head, 0, 16, 0)
  fs.closeSync(fd)
  if (head.toString('latin1') !== 'SQLite format 3\0') throw new Refused('invalid', 'seedypod.db is not an SQLite database')
  const here = installedSchema()
  if (m.schema.migrations > here.migrations) {
    throw new Refused('newer-schema', `This backup was made by seedypod core ${m.core?.version ?? 'unknown'} (database schema ${m.schema.migrations}); this unit's core has schema ${here.migrations}. Install that version of core or newer first (scripts/install), then restore again.`)
  }
  return m
}

/** Stages and checks a bundle in the root-only staging directory. */
async function stage(bundle) {
  if (!fs.existsSync(bundle)) throw new Refused('invalid', `no such file: ${bundle}`)
  fs.mkdirSync(P.work, { recursive: true, mode: 0o755 })
  fs.rmSync(STAGING, { recursive: true, force: true })
  fs.mkdirSync(path.join(STAGING, 'files'), { recursive: true, mode: 0o700 })
  fs.chmodSync(STAGING, 0o700)
  const names = await extract(bundle, path.join(STAGING, 'files'))
  const manifest = verify(path.join(STAGING, 'files'), names)
  fs.writeFileSync(path.join(STAGING, 'names.json'), JSON.stringify(names))
  return { manifest, names }
}

// ---- system ----------------------------------------------------------------------

function systemctl(...args) {
  const cmd = env('SEEDYPOD_SYSTEMCTL') ? JSON.parse(env('SEEDYPOD_SYSTEMCTL')) : ['systemctl']
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  return r.status === 0
}

function lookup(file, name) {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(`${name}:`))
    return line ? Number(line.split(':')[2]) : null
  }
  catch {
    return null
  }
}

/** Owner and mode for a restored file, as the installers set them. Ownership only changes as root. */
function settle(file, kind) {
  if (!isRoot) return
  const own = (uid, gid) => uid !== null && gid !== null && fs.chownSync(file, uid, gid)
  const ofDir = (d) => {
    const s = fs.statSync(fs.existsSync(d) ? d : path.dirname(d))
    return [s.uid, s.gid]
  }
  if (kind === 'db' || kind === 'captures') {
    const [uid, gid] = ofDir(path.dirname(P.db))
    if (kind === 'captures') {
      const walk = (p) => {
        fs.chownSync(p, uid, gid)
        if (fs.statSync(p).isDirectory()) for (const c of fs.readdirSync(p)) walk(path.join(p, c))
      }
      walk(file)
    }
    else own(uid, gid)
  }
  else if (kind === 'hal') {
    own(0, lookup('/etc/group', 'seedypod') ?? 0)
    fs.chmodSync(file, 0o644)
  }
  else if (kind === 'passwd') {
    own(lookup('/etc/passwd', 'mosquitto') ?? 0, lookup('/etc/group', 'seedypod') ?? 0)
    fs.chmodSync(file, 0o640)
  }
  else if (kind === 'state') {
    const [uid, gid] = ofDir(P.state)
    own(uid, gid)
    fs.chmodSync(file, 0o644)
  }
}

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  }
  catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

const LAN_LISTENER = `
# Home Assistant and other LAN clients, with a password (${P.passwd}).
listener 1884
allow_anonymous false
password_file ${P.passwd}
`

/** A restored password file needs the LAN listener; the helper writes that block itself and never restores Mosquitto's config. */
function ensureLanListener() {
  if (!fs.existsSync(P.mosquittoConf)) return false
  const conf = fs.readFileSync(P.mosquittoConf, 'utf8')
  if (!/^listener 1884/m.test(conf)) fs.appendFileSync(P.mosquittoConf, LAN_LISTENER)
  return true
}

function writeStatus(s) {
  fs.mkdirSync(P.work, { recursive: true, mode: 0o755 })
  const tmp = `${STATUS}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ ...s, at: new Date().toISOString() })}\n`, { mode: 0o644 })
  fs.renameSync(tmp, STATUS)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch {
    return null
  }
}

// ---- restore and undo --------------------------------------------------------------

/** What a restore of these staged names replaces: [relative name in pre-restore, live path, staged path or null, kind]. */
function plan(names, manifest) {
  const files = path.join(STAGING, 'files')
  const items = [
    ['data/seedypod.db', P.db, path.join(files, 'seedypod.db'), 'db'],
    ['data/seedypod.db-wal', `${P.db}-wal`, null, 'db'],
    ['data/seedypod.db-shm', `${P.db}-shm`, null, 'db'],
  ]
  if (names.includes('etc/seedypod/hal.toml')) items.push(['etc/seedypod/hal.toml', path.join(P.etc, 'hal.toml'), path.join(files, 'etc/seedypod/hal.toml'), 'hal'])
  if (names.includes('etc/mosquitto/seedypod.passwd')) items.push(['etc/mosquitto/seedypod.passwd', P.passwd, path.join(files, 'etc/mosquitto/seedypod.passwd'), 'passwd'])
  const state = names.filter(n => n.startsWith('var/lib/seedypod/')).map(n => path.basename(n))
  if (state.length) {
    const live = fs.existsSync(P.state) ? fs.readdirSync(P.state).filter(f => /^[a-z0-9_-]+\.json$/.test(f)) : []
    for (const f of [...new Set([...state, ...live])].sort()) {
      items.push([`var/lib/seedypod/${f}`, path.join(P.state, f), state.includes(f) ? path.join(files, 'var/lib/seedypod', f) : null, 'state'])
    }
  }
  if (manifest.photos) items.push(['data/captures', P.captures, fs.existsSync(path.join(files, 'captures')) ? path.join(files, 'captures') : null, 'captures'])
  return items
}

function stopServices() {
  systemctl('stop', 'seedypod-core')
  systemctl('stop', 'hald')
}

function startServices(mosquitto) {
  if (mosquitto) systemctl('try-restart', 'mosquitto')
  const hald = systemctl('start', 'hald')
  const core = systemctl('start', 'seedypod-core')
  return hald && core
}

function apply() {
  const names = readJson(path.join(STAGING, 'names.json'))
  if (!names) throw new Error('nothing staged; run seedypod-restore <bundle> first')
  // Re-check here: this step runs as its own unit, after the bundle was checked.
  const manifest = verify(path.join(STAGING, 'files'), names)
  const items = plan(names, manifest)
  const fresh = `${PRE}.new`
  writeStatus({ op: 'restore', state: 'stopping', bundle: summary(manifest) })
  stopServices()
  writeStatus({ op: 'restore', state: 'restoring', bundle: summary(manifest) })
  fs.rmSync(fresh, { recursive: true, force: true })
  fs.mkdirSync(fresh, { recursive: true, mode: 0o700 })
  const done = []
  try {
    for (const [rel, live, staged, kind] of items) {
      const existed = fs.existsSync(live)
      if (existed) move(live, path.join(fresh, rel))
      done.push({ rel, live, existed, kind })
      if (staged) {
        move(staged, live)
        settle(live, kind)
      }
    }
  }
  catch (e) {
    // Put back whatever already moved, then bring the services up on the old files.
    for (const d of done.reverse()) {
      fs.rmSync(d.live, { recursive: true, force: true })
      if (d.existed) move(path.join(fresh, d.rel), d.live)
    }
    fs.rmSync(fresh, { recursive: true, force: true })
    startServices(false)
    throw e
  }
  const passwd = items.some(([, , staged, kind]) => kind === 'passwd' && staged)
  const mosquitto = passwd && ensureLanListener()
  // The previous pre-restore is kept until this restore has succeeded.
  fs.rmSync(PRE, { recursive: true, force: true })
  fs.renameSync(fresh, PRE)
  fs.writeFileSync(UNDO_INFO, `${JSON.stringify({ restoredAt: new Date().toISOString(), bundle: summary(manifest), items: done, undoneAt: null }, null, 2)}\n`, { mode: 0o644 })
  fs.rmSync(STAGING, { recursive: true, force: true })
  writeStatus({ op: 'restore', state: 'starting', bundle: summary(manifest) })
  if (!startServices(mosquitto)) throw new Error('the services did not start; see journalctl -u hald -u seedypod-core')
  writeStatus({ op: 'restore', state: 'done', bundle: summary(manifest) })
}

/** Swaps every item between its live path and pre-restore, so a second undo redoes the restore. */
function undo() {
  const info = readJson(UNDO_INFO)
  if (!info || !fs.existsSync(PRE)) throw new Refused('invalid', 'there is no restore to undo')
  writeStatus({ op: 'undo', state: 'stopping', bundle: info.bundle })
  stopServices()
  writeStatus({ op: 'undo', state: 'restoring', bundle: info.bundle })
  const swap = path.join(P.work, 'swap')
  fs.rmSync(swap, { recursive: true, force: true })
  for (const item of info.items) {
    const tmp = path.join(swap, item.rel)
    const liveExists = fs.existsSync(item.live)
    if (liveExists) move(item.live, tmp)
    if (item.existed) {
      move(path.join(PRE, item.rel), item.live)
      settle(item.live, item.kind)
    }
    if (liveExists) move(tmp, path.join(PRE, item.rel))
    item.existed = liveExists
  }
  fs.rmSync(swap, { recursive: true, force: true })
  info.undoneAt = info.undoneAt ? null : new Date().toISOString()
  fs.writeFileSync(UNDO_INFO, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 })
  const mosquitto = info.items.some(i => i.kind === 'passwd') && fs.existsSync(P.passwd) && ensureLanListener()
  writeStatus({ op: 'undo', state: 'starting', bundle: info.bundle })
  if (!startServices(mosquitto)) throw new Error('the services did not start; see journalctl -u hald -u seedypod-core')
  writeStatus({ op: 'undo', state: 'done', bundle: info.bundle, undone: !!info.undoneAt })
}

function summary(m) {
  return { createdAt: m.createdAt ?? null, unit: m.unit ?? null, core: m.core?.version ?? null, schema: m.schema?.migrations ?? null, photos: !!m.photos }
}

/**
 * Runs `args` after this process exits. Core calls with --detach because
 * stopping seedypod-core would otherwise stop this helper with it.
 */
function detach(args) {
  const self = [process.execPath, __filename, ...args]
  if (env('SEEDYPOD_RESTORE_DETACH') !== 'fork' && isRoot && fs.existsSync('/usr/bin/systemd-run')) {
    execFileSync('/usr/bin/systemd-run', ['--quiet', '--collect', `--unit=seedypod-restore-${Date.now()}`, '--description=seedypod restore (ADR-0021)', ...self])
    return
  }
  spawn(self[0], self.slice(1), { detached: true, stdio: 'ignore', env: process.env }).unref()
}

// ---- CLI -------------------------------------------------------------------------------

function result(code, obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exitCode = code
}

async function main(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--')))
  const [bundle] = argv.filter(a => !a.startsWith('--'))
  try {
    if (flags.has('--status')) return result(0, { ok: true, status: readJson(STATUS), undo: readJson(UNDO_INFO) })
    if (flags.has('--apply')) {
      try {
        apply()
      }
      catch (e) {
        writeStatus({ op: 'restore', state: 'failed', error: e.message })
        throw e
      }
      return result(0, { ok: true, done: true })
    }
    if (flags.has('--undo')) {
      if (!readJson(UNDO_INFO)) throw new Refused('invalid', 'there is no restore to undo')
      if (flags.has('--detach')) {
        writeStatus({ op: 'undo', state: 'queued' })
        detach(['--undo-now'])
        return result(0, { ok: true, detached: true })
      }
      return runUndo()
    }
    if (flags.has('--undo-now')) return runUndo()
    if (!bundle) {
      process.stderr.write('usage: seedypod-restore [--check | --detach] <bundle.tar.gz> | --undo [--detach] | --status\n')
      return result(2, { ok: false, code: 'usage', error: 'no bundle given' })
    }
    writeStatus({ op: 'restore', state: 'checking' })
    const { manifest } = await stage(bundle)
    if (flags.has('--check')) {
      fs.rmSync(STAGING, { recursive: true, force: true })
      writeStatus({ op: 'check', state: 'done', bundle: summary(manifest) })
      return result(0, { ok: true, bundle: summary(manifest) })
    }
    if (flags.has('--detach')) {
      writeStatus({ op: 'restore', state: 'queued', bundle: summary(manifest) })
      detach(['--apply'])
      return result(0, { ok: true, detached: true, bundle: summary(manifest) })
    }
    try {
      apply()
    }
    catch (e) {
      writeStatus({ op: 'restore', state: 'failed', error: e.message })
      throw e
    }
    process.stderr.write(`restored the backup from ${manifest.createdAt}; undo with: sudo seedypod-restore --undo\n`)
    return result(0, { ok: true, bundle: summary(manifest) })
  }
  catch (e) {
    if (e instanceof Refused) {
      fs.rmSync(STAGING, { recursive: true, force: true })
      writeStatus({ op: 'restore', state: 'refused', code: e.code, error: e.message })
      process.stderr.write(`${e.message}\n`)
      return result(e.code === 'newer-schema' ? 3 : 4, { ok: false, code: e.code, error: e.message })
    }
    process.stderr.write(`restore failed: ${e.message}\n`)
    return result(1, { ok: false, code: 'failed', error: e.message })
  }
}

function runUndo() {
  try {
    undo()
  }
  catch (e) {
    writeStatus({ op: 'undo', state: 'failed', error: e.message })
    throw e
  }
  return result(0, { ok: true, done: true })
}

if (require.main === module) void main(process.argv.slice(2))

module.exports = { main, extract, verify, paths: P, NAMES }
