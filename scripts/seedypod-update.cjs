#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// seedypod update helper (ADR-0026). Installed root-owned at
// /usr/local/sbin/seedypod-update by scripts/install, which writes the install
// prefix in and lets core's user run it with sudo, with these arguments only.
// Node built-ins only; it must not load anything the core user can write.
//
// Usage: seedypod-update --status                 print the channel, what's installed and the last run
//        seedypod-update --channel stable|dev     remember the channel to update from
//        seedypod-update --check                  ask GitHub for the newest release on that channel
//        seedypod-update --start                  check, then update in its own unit (what core calls)
//        seedypod-update --now                    check, then update here (over SSH)
//        seedypod-update --rollback               put back what the last update replaced (over SSH)
// It only downloads release assets CI built, checks each one's sha256, and
// never compiles: a release that would need it is refused. A failed health
// check puts the previous version back, hald and podvision (#191) with it.
// Exit codes: 0 ok, 1 failed, 2 usage, 4 refused (checksum, nothing newer, needs scripts/install), 5 busy.
// The last line of stdout is a JSON result for core.
'use strict'

const { execFileSync, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const INSTALLED_PREFIX = '__PREFIX__'
const REPO = 'seedypod/core'
const CHANNELS = { stable: 'latest', dev: 'dev-latest' }
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
// Overrides exist for tests; as root (under sudo) only the installed paths count.
const env = name => (isRoot ? undefined : process.env[name]) || undefined
const prefix = env('SEEDYPOD_UPDATE_PREFIX') ?? (INSTALLED_PREFIX.startsWith('__') ? path.resolve(__dirname, '..') : INSTALLED_PREFIX)

const P = {
  prefix,
  next: `${prefix}.next`,
  previous: `${prefix}.previous`,
  work: env('SEEDYPOD_UPDATE_WORK') ?? '/var/lib/seedypod-update',
  api: env('SEEDYPOD_UPDATE_API') ?? 'https://api.github.com',
  downloads: env('SEEDYPOD_UPDATE_DOWNLOADS') ?? `https://github.com/${REPO}/releases/download/`,
  coreUnit: env('SEEDYPOD_UPDATE_CORE_UNIT') ?? '/etc/systemd/system/seedypod-core.service',
  haldUnit: env('SEEDYPOD_UPDATE_HALD_UNIT') ?? '/etc/systemd/system/hald.service',
  hald: env('SEEDYPOD_UPDATE_HALD') ?? '/usr/local/bin/hald',
  podvision: env('SEEDYPOD_UPDATE_PODVISION') ?? '/usr/local/bin/podvision',
  target: env('SEEDYPOD_UPDATE_TARGET'),
  sbin: env('SEEDYPOD_UPDATE_SBIN') ?? '/usr/local/sbin',
  compileCache: env('SEEDYPOD_UPDATE_COMPILE_CACHE') ?? '/var/cache/seedypod/compile-cache',
  busy: env('SEEDYPOD_UPDATE_BUSY') ?? '/run/seedypod-busy',
  share: env('SEEDYPOD_UPDATE_SHARE') ?? '/usr/local/share/seedypod',
}
const STATUS = path.join(P.work, 'status.json')
const LOG = path.join(P.work, 'update.log')
const CHANNEL = path.join(P.work, 'channel')
const INSTALLED = path.join(P.work, 'installed.json')
// The last check's answer, which core shows on the SSH login screen without going online.
const CHECKED = path.join(P.work, 'check.json')
const PLAN = path.join(P.work, 'plan.json')
const LOCK = path.join(P.work, 'lock')
const DL = path.join(P.work, 'downloads')
const META = path.join(P.previous, 'meta.json')
// Never part of a release: core's data, the installed dependencies, pnpm's store and local env files.
const KEEP = name => name === 'data' || name === 'node_modules' || name === '.pnpm-store' || name.startsWith('.env')
// The SSH login screen's files under P.share (scripts/install's install_login_logo).
const LOGIN_FILES = ['login-logo', 'login-stats', 'logo.frames']
const REQUIRED = ['server/dist/index.js', 'web/dist/index.html', 'package.json', 'pnpm-lock.yaml', '.git-info', 'scripts/seedypod-update.cjs', 'scripts/seedypod-restore.cjs']
// A Pi Zero W can take minutes to start core, more with migrations to run.
const HEALTH_TIMEOUT_S = Number(env('SEEDYPOD_UPDATE_HEALTH_TIMEOUT') ?? 600)
const POLL_MS = Number(env('SEEDYPOD_UPDATE_POLL_MS') ?? 2000)
const PNPM_TIMEOUT_MS = 30 * 60_000
const MAX_ASSET_BYTES = 512 * 1024 * 1024

class Refused extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---- state files ---------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch {
    return null
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644 })
  fs.renameSync(tmp, file)
}

let current = {}
function setStatus(patch) {
  current = { ...current, ...patch, at: new Date().toISOString() }
  writeJson(STATUS, current)
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`
  process.stderr.write(text)
  try {
    fs.appendFileSync(LOG, text, { mode: 0o644 })
  }
  catch {
    // The log is for the UI; the update goes on without it.
  }
}

function gitInfo(dir) {
  const info = readJson(path.join(dir, '.git-info')) ?? {}
  return { branch: info.branch ?? null, commit: info.commitHash ?? null, version: info.branch && info.commitHash ? `${info.branch}@${info.commitHash}` : null }
}

function channel() {
  try {
    const c = fs.readFileSync(CHANNEL, 'utf8').trim()
    if (Object.hasOwn(CHANNELS, c)) return c
  }
  catch {
    // fall through to the installed branch
  }
  return gitInfo(P.prefix).branch === 'main' ? 'stable' : 'dev'
}

function installed() {
  const here = gitInfo(P.prefix)
  const rec = readJson(INSTALLED)
  // A record from an earlier update only counts while that build is still the one installed.
  const tag = rec && rec.commit && here.commit && rec.commit.startsWith(here.commit) ? rec.tag : null
  return { ...here, tag }
}

// ---- GitHub ----------------------------------------------------------------------------

async function get(url, accept) {
  const r = await fetch(url, { headers: { 'accept': accept, 'user-agent': 'seedypod-update' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (r.status === 404) throw new Refused('no-release', `no release at ${url}`)
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${url}${r.status === 403 ? ' (rate limited? try again in an hour)' : ''}`)
  return r
}

/** The newest release on a channel, with each asset's download URL and GitHub's digest. */
async function resolve(ch) {
  const tag = CHANNELS[ch]
  const url = tag === 'latest' ? `${P.api}/repos/${REPO}/releases/latest` : `${P.api}/repos/${REPO}/releases/tags/${tag}`
  let release
  try {
    release = await (await get(url, 'application/vnd.github+json')).json()
  }
  catch (e) {
    if (e instanceof Refused) throw new Refused('no-release', `there is no ${ch} release yet`)
    throw new Error(`couldn't reach GitHub: ${e.cause?.message ?? e.message}`)
  }
  if (typeof release?.tag_name !== 'string' || !Array.isArray(release.assets)) throw new Error('GitHub sent an unexpected answer')
  const commit = (await (await get(`${P.api}/repos/${REPO}/commits/${encodeURIComponent(release.tag_name)}`, 'application/vnd.github.sha')).text()).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`GitHub sent no commit for ${release.tag_name}`)
  const assets = {}
  for (const a of release.assets) {
    if (typeof a?.name !== 'string' || typeof a.browser_download_url !== 'string') continue
    // Only this repository's release downloads, whatever the answer says.
    if (!a.browser_download_url.startsWith(P.downloads)) continue
    assets[a.name] = { url: a.browser_download_url, size: a.size ?? null, digest: typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(a.digest) ? a.digest.slice(7) : null }
  }
  return { channel: ch, tag: release.tag_name, commit, name: release.name ?? release.tag_name, publishedAt: release.published_at ?? null, url: release.html_url ?? null, assets }
}

function haldTarget() {
  if (P.target) return P.target
  const m = os.machine()
  if (m === 'aarch64' || m === 'arm64') return (() => {
    try {
      return execFileSync('getconf', ['LONG_BIT'], { encoding: 'utf8' }).trim() === '32' ? 'arm-unknown-linux-gnueabihf' : 'aarch64-unknown-linux-gnu'
    }
    catch {
      return 'aarch64-unknown-linux-gnu'
    }
  })()
  if (/^armv[67]l$/.test(m) || m === 'armhf') return 'arm-unknown-linux-gnueabihf'
  return null
}

/** hald's target, and on armv8l, which hald isn't updated for, the 32-bit build scripts/install picks there. */
function podvisionTarget() {
  return haldTarget() ?? (os.machine() === 'armv8l' ? 'arm-unknown-linux-gnueabihf' : null)
}

function updatesHald() {
  return fs.existsSync(P.haldUnit) && fs.existsSync(P.hald) && !!haldTarget()
}

async function check() {
  const ch = channel()
  const release = await resolve(ch)
  const here = installed()
  const missing = ['seedypod-core.tar.gz']
  if (updatesHald()) missing.push(`hald-${haldTarget()}`)
  const absent = missing.filter(n => !release.assets[n])
  const unchecked = missing.filter(n => release.assets[n] && !release.assets[n].digest && !release.assets[`${n}.sha256`])
  const fresh = !here.commit || !release.commit.startsWith(here.commit)
  const available = { tag: release.tag, commit: release.commit, name: release.name, publishedAt: release.publishedAt, url: release.url }
  const problem = absent.length ? `the release has no ${absent.join(' or ')}` : unchecked.length ? `the release has no checksum for ${unchecked.join(' or ')}` : null
  try {
    writeJson(CHECKED, { at: new Date().toISOString(), channel: ch, available, problem })
  }
  catch {
    // Only the login screen reads it.
  }
  return {
    channel: ch,
    installed: here,
    available,
    updateAvailable: fresh,
    problem,
    release,
  }
}

// ---- downloads and checksums -------------------------------------------------------------

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

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'seedypod-update' }, redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) })
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      const out = fs.openSync(file, 'w', 0o644)
      let bytes = 0
      try {
        for await (const chunk of r.body) {
          bytes += chunk.length
          if (bytes > MAX_ASSET_BYTES) throw new Refused('invalid', `${path.basename(file)} is larger than any release asset should be`)
          fs.writeSync(out, chunk)
        }
      }
      finally {
        fs.closeSync(out)
      }
      return bytes
    }
    catch (e) {
      if (e instanceof Refused) throw e
      if (attempt >= 3) throw new Error(`couldn't download ${path.basename(file)}: ${e.cause?.message ?? e.message}`)
      log(`download of ${path.basename(file)} failed (${e.message}); trying again`)
    }
  }
}

/**
 * Downloads a release asset and checks it against the `<name>.sha256` asset CI
 * published next to it and GitHub's own digest. At least one must exist, and
 * every one that does must match.
 */
async function fetchAsset(release, name) {
  const asset = release.assets[name]
  if (!asset) throw new Refused('missing-asset', `the ${release.tag} release has no ${name}`)
  // Public assets; core's account reads the ARMv6 prebuilt and runs hald --version from here.
  fs.mkdirSync(DL, { recursive: true, mode: 0o755 })
  const file = path.join(DL, name)
  log(`downloading ${name}`)
  const bytes = await download(asset.url, file)
  const expected = []
  if (release.assets[`${name}.sha256`]) {
    const sumFile = `${file}.sha256`
    await download(release.assets[`${name}.sha256`].url, sumFile)
    const hex = fs.readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0]
    if (!/^[0-9a-f]{64}$/i.test(hex ?? '')) throw new Refused('checksum', `${name}.sha256 is not a sha256 checksum`)
    expected.push(['the release\'s checksum file', hex.toLowerCase()])
  }
  if (asset.digest) expected.push(['GitHub\'s digest', asset.digest])
  if (!expected.length) throw new Refused('checksum', `the ${release.tag} release has no checksum for ${name}, so it can't be checked`)
  const actual = sha256(file)
  for (const [from, hex] of expected) {
    if (hex !== actual) throw new Refused('checksum', `${name} doesn't match ${from} (sha256 ${actual.slice(0, 12)}…, expected ${hex.slice(0, 12)}…); nothing was changed`)
  }
  log(`${name}: ${bytes} bytes, sha256 ${actual.slice(0, 12)}… matches`)
  return file
}

// ---- system ----------------------------------------------------------------------------

function run(cmd, args, o = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, uid: o.uid, gid: o.gid, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const take = (d) => {
      out += d
      for (const line of String(d).split('\n')) if (line.trim() && o.log) log(`  ${line.trimEnd()}`)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = o.timeout ? setTimeout(() => child.kill('SIGKILL'), o.timeout) : null
    child.on('error', e => resolve({ code: 127, out: e.message }))
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? (signal ? 128 : 1), out })
    })
  })
}

async function systemctl(...args) {
  const cmd = env('SEEDYPOD_SYSTEMCTL') ? JSON.parse(env('SEEDYPOD_SYSTEMCTL')) : ['systemctl']
  return (await run(cmd[0], [...cmd.slice(1), ...args])).code === 0
}

function lookup(file, name, field) {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(`${name}:`))
    return line ? line.split(':')[field] : null
  }
  catch {
    return null
  }
}

/** Who core runs as, from its unit; the dependencies are installed as that account, never as root. */
function coreAccount() {
  let user = null
  try {
    user = /^User=(.+)$/m.exec(fs.readFileSync(P.coreUnit, 'utf8'))?.[1]?.trim() ?? null
  }
  catch {
    // fall through
  }
  if (!isRoot) return { user: os.userInfo().username, uid: undefined, gid: undefined, home: os.homedir() }
  if (!user) throw new Error(`no User= in ${P.coreUnit}`)
  const uid = Number(lookup('/etc/passwd', user, 2))
  const gid = Number(lookup('/etc/passwd', user, 3))
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) throw new Error(`core's account ${user} isn't a normal user`)
  return { user, uid, gid, home: lookup('/etc/passwd', user, 5) }
}

function corePort() {
  try {
    return /\bPORT=(\d+)/.exec(fs.readFileSync(P.coreUnit, 'utf8'))?.[1] ?? '3000'
  }
  catch {
    return '3000'
  }
}

const coreUrl = () => env('SEEDYPOD_UPDATE_CORE_URL') ?? `http://127.0.0.1:${corePort()}`

async function coreAnswer() {
  try {
    const health = await fetch(`${coreUrl()}/api/healthcheck`, { signal: AbortSignal.timeout(5000) })
    if (!health.ok) return null
    const sys = await fetch(`${coreUrl()}/api/system`, { signal: AbortSignal.timeout(5000) })
    if (!sys.ok) return null
    return await sys.json()
  }
  catch {
    return null
  }
}

/** Core answers, runs the version expected, and sees hald if it did before. */
async function healthy(version, needHal) {
  const deadline = Date.now() + HEALTH_TIMEOUT_S * 1000
  let last = 'core did not answer'
  while (Date.now() < deadline) {
    const sys = await coreAnswer()
    if (sys) {
      if (version && sys.coreVersion !== version) last = `core answers as ${sys.coreVersion}, not ${version}`
      else if (needHal && !sys.halOnline) last = 'core runs but does not see hald'
      else return { ok: true }
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  return { ok: false, error: `${last} within ${HEALTH_TIMEOUT_S} s` }
}

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  }
  catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

/** Hands a tree to core's account without following links. Ownership only changes as root. */
function own(p, acct) {
  if (!isRoot) return
  fs.lchownSync(p, acct.uid, acct.gid)
  const st = fs.lstatSync(p)
  if (st.isDirectory()) for (const c of fs.readdirSync(p)) own(path.join(p, c), acct)
}

function markBusy(on) {
  try {
    if (on) {
      fs.mkdirSync(P.busy, { recursive: true })
      fs.writeFileSync(path.join(P.busy, 'update'), '')
    }
    else fs.rmSync(path.join(P.busy, 'update'), { force: true })
  }
  catch {
    // Only tells hald's USB recovery to hold off; never worth failing for.
  }
}

/** Installs a root helper from the checked release, with this prefix written in. */
function installHelper(from, name) {
  const dest = path.join(P.sbin, name)
  const tmp = `${dest}.new`
  fs.mkdirSync(P.sbin, { recursive: true })
  // Spelled in two halves so the installer's sed, which writes the prefix into this file, leaves it alone.
  fs.writeFileSync(tmp, fs.readFileSync(from, 'utf8').replace(['__PRE', 'FIX__'].join(''), P.prefix), { mode: 0o755 })
  if (isRoot) fs.chownSync(tmp, 0, 0)
  // A rename, so this running copy keeps reading its own inode.
  fs.renameSync(tmp, dest)
}

/**
 * Rewrites the version the SSH login screen falls back to when core doesn't answer,
 * as scripts/install wrote it, so that it follows what's in the prefix now.
 */
function pinVersion() {
  const file = path.join(P.share, 'version')
  try {
    if (!fs.existsSync(file)) return
    const { branch, commit } = gitInfo(P.prefix)
    fs.writeFileSync(`${file}.new`, `${branch ?? 'dev'}${commit ? `@${commit}` : ''}\n`, { mode: 0o644 })
    if (isRoot) fs.chownSync(`${file}.new`, 0, 0)
    fs.renameSync(`${file}.new`, file)
  }
  catch (e) {
    log(`couldn't update ${file}: ${e.message}`)
  }
}

/**
 * Refreshes the SSH login screen's scripts from the checked release, as scripts/install
 * placed them, so a web update brings login changes too. Only where install put them
 * there; a rollback keeps the newer ones, which fall back quietly when core lacks a route.
 */
function refreshLogin(from) {
  if (!fs.existsSync(path.join(P.share, 'login-logo'))) return
  for (const n of LOGIN_FILES) {
    const src = path.join(from, n)
    const dest = path.join(P.share, n)
    try {
      if (!fs.existsSync(src)) continue
      fs.copyFileSync(src, `${dest}.new`)
      fs.chmodSync(`${dest}.new`, n === 'logo.frames' ? 0o644 : 0o755)
      if (isRoot) fs.chownSync(`${dest}.new`, 0, 0)
      fs.renameSync(`${dest}.new`, dest)
    }
    catch (e) {
      log(`couldn't update ${dest}: ${e.message}`)
    }
  }
}

// ---- locking -------------------------------------------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (e) {
    return e.code === 'EPERM'
  }
}

function lock() {
  fs.mkdirSync(P.work, { recursive: true, mode: 0o755 })
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx', mode: 0o644 })
      return
    }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number(fs.readFileSync(LOCK, 'utf8'))
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Refused('busy', 'an update is already running')
      fs.rmSync(LOCK, { force: true })
    }
  }
  throw new Refused('busy', 'an update is already running')
}

function unlock() {
  try {
    if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK, { force: true })
  }
  catch {
    // gone already
  }
}

// ---- the update --------------------------------------------------------------------------------

const sqliteVersion = lockfile => /^ {2}better-sqlite3@([0-9][^:(]*):$/m.exec(fs.readFileSync(lockfile, 'utf8'))?.[1] ?? null
const depsStamp = () => path.join(P.prefix, 'node_modules', `.seedypod-lock-${process.version}`)

function depsChanged(stage) {
  try {
    return !fs.readFileSync(path.join(stage, 'pnpm-lock.yaml')).equals(fs.readFileSync(depsStamp()))
  }
  catch {
    return true
  }
}

/** The Node major a release wants here: .node-version, or the Node 22 its installer pins on 32-bit ARM. */
function wantedNodeMajor(stage) {
  if (process.arch === 'arm') {
    const pin = /^NODE_22=(\d+)\./m.exec(fs.readFileSync(path.join(stage, 'scripts/install'), 'utf8'))?.[1]
    return pin ? Number(pin) : null
  }
  const v = /^v?(\d+)/.exec(fs.readFileSync(path.join(stage, '.node-version'), 'utf8').trim())?.[1]
  return v ? Number(v) : null
}

async function unpack(tarball) {
  fs.rmSync(P.next, { recursive: true, force: true })
  fs.mkdirSync(P.next, { recursive: true, mode: 0o755 })
  const r = await run('tar', ['-xzf', tarball, '-C', P.next, '--no-same-owner'])
  if (r.code !== 0) throw new Refused('invalid', `seedypod-core.tar.gz didn't unpack: ${r.out.trim()}`)
  // A release from before ADR-0026 would leave the unit with no way to update from the web.
  if (!fs.existsSync(path.join(P.next, 'scripts/seedypod-update.cjs'))) throw new Refused('needs-install', 'this release is older than updating from the web; install it over SSH with scripts/install')
  for (const f of REQUIRED) if (!fs.existsSync(path.join(P.next, f))) throw new Refused('invalid', `the release is missing ${f}`)
  for (const n of fs.readdirSync(P.next)) if (KEEP(n)) fs.rmSync(path.join(P.next, n), { recursive: true, force: true })
  const want = wantedNodeMajor(P.next)
  const have = Number(process.versions.node.split('.')[0])
  if (want && want !== have) throw new Refused('needs-install', `this release runs on Node ${want} and the unit has Node ${have}; update over SSH with scripts/install`)
}

/** The ARMv6 better-sqlite3 CI built, so a Pi Zero W never compiles it. Mirrors fetch_sqlite_prebuilt in scripts/install. */
async function sqlitePrebuilt(release, stage) {
  const version = sqliteVersion(path.join(stage, 'pnpm-lock.yaml'))
  if (!version) return null
  const abi = process.versions.modules
  const name = `better-sqlite3-v${version}-node-v${abi}-linux-armv6.tar.gz`
  if (!release.assets[name]) throw new Refused('needs-install', `the release has no ARMv6 better-sqlite3 ${version} for this Node, and the unit would spend an hour compiling it; update over SSH with scripts/install`)
  const file = await fetchAsset(release, name)
  const dir = path.join(DL, 'sqlite')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'prebuilds'), { recursive: true })
  const r = await run('tar', ['-xzf', file, '-C', dir, '--no-same-owner', 'build/Release/better_sqlite3.node'])
  if (r.code !== 0) throw new Refused('invalid', `${name} didn't unpack`)
  // prebuild-install looks it up by process.arch, which doesn't say ARMv6.
  fs.renameSync(file, path.join(dir, 'prebuilds', `better-sqlite3-v${version}-node-v${abi}-linux-arm.tar.gz`))
  return { dir: path.join(dir, 'prebuilds'), binary: path.join(dir, 'build/Release/better_sqlite3.node'), version }
}

function pnpmCommand() {
  if (env('SEEDYPOD_UPDATE_PNPM')) return JSON.parse(env('SEEDYPOD_UPDATE_PNPM'))
  return fs.existsSync('/usr/local/bin/pnpm') ? ['/usr/local/bin/pnpm'] : ['/usr/local/bin/corepack', 'pnpm']
}

/** pnpm install as core's account, with the store node_modules was linked from. No compiler: a build would outlast the timeout. */
async function installDeps(acct, sqlite) {
  let store = null
  try {
    store = /^storeDir: (.+)$/m.exec(fs.readFileSync(path.join(P.previous, 'node_modules/.modules.yaml'), 'utf8'))?.[1]?.trim() ?? null
  }
  catch {
    // pnpm's default
  }
  let home = acct.home
  if (!home || !fs.existsSync(home)) {
    home = path.join(P.work, `home-${acct.user}`)
    fs.mkdirSync(home, { recursive: true })
    own(home, acct)
  }
  // Corepack would otherwise stop to ask before fetching a pnpm newer than the one it has.
  const e = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_build_from_source: 'false' }
  if (store) e.npm_config_store_dir = store
  if (sqlite) e.npm_config_better_sqlite3_local_prebuilds = sqlite.dir
  const cmd = pnpmCommand()
  log('installing dependencies (pnpm install --prod --frozen-lockfile)')
  const r = await run(cmd[0], [...cmd.slice(1), 'install', '--prod', '--frozen-lockfile'], { cwd: P.prefix, env: e, uid: acct.uid, gid: acct.gid, timeout: PNPM_TIMEOUT_MS, log: true })
  if (r.code !== 0) throw new Error(`pnpm install failed (exit ${r.code})`)
  const works = await run(process.execPath, ['-e', 'new (require(\'better-sqlite3\'))(\':memory:\').exec(\'create table t (x)\')'], { cwd: P.prefix, env: e, uid: acct.uid, gid: acct.gid })
  if (works.code !== 0) throw new Error('better-sqlite3 does not load after the install')
  if (sqlite) {
    const landed = path.join(P.prefix, `node_modules/.pnpm/better-sqlite3@${sqlite.version}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`)
    if (!fs.existsSync(landed) || !fs.readFileSync(landed).equals(fs.readFileSync(sqlite.binary))) throw new Error('pnpm did not use the ARMv6 better-sqlite3')
  }
  fs.copyFileSync(path.join(P.prefix, 'pnpm-lock.yaml'), depsStamp())
  own(depsStamp(), acct)
}

const DB_FILES = ['seedypod.db', 'seedypod.db-wal', 'seedypod.db-shm']

async function startAndCheck(meta, version) {
  setStatus({ state: 'starting' })
  if (meta.hald) await systemctl('start', 'hald')
  await systemctl('start', 'seedypod-core')
  setStatus({ state: 'health' })
  log(`waiting up to ${HEALTH_TIMEOUT_S} s for core ${version ?? ''} to answer`)
  return healthy(version, meta.halOnline)
}

/** Puts back everything `meta` says the update replaced, then starts the services on it. */
async function putBack(meta) {
  await systemctl('stop', 'seedypod-core')
  if (meta.hald) await systemctl('stop', 'hald')
  for (const n of meta.placed ?? []) fs.rmSync(path.join(P.prefix, n), { recursive: true, force: true })
  for (const n of meta.moved ?? []) {
    const from = path.join(P.previous, 'code', n)
    if (fs.existsSync(from)) {
      fs.rmSync(path.join(P.prefix, n), { recursive: true, force: true })
      move(from, path.join(P.prefix, n))
    }
  }
  if (meta.nodeModules && fs.existsSync(path.join(P.previous, 'node_modules'))) {
    fs.rmSync(path.join(P.prefix, 'node_modules'), { recursive: true, force: true })
    move(path.join(P.previous, 'node_modules'), path.join(P.prefix, 'node_modules'))
  }
  if (meta.db) {
    const data = path.join(P.prefix, 'data')
    const st = fs.statSync(data)
    for (const f of DB_FILES) {
      const saved = path.join(P.previous, 'db', f)
      const live = path.join(data, f)
      if (fs.existsSync(saved)) {
        fs.copyFileSync(saved, live)
        if (isRoot) fs.chownSync(live, st.uid, st.gid)
      }
      else fs.rmSync(live, { force: true })
    }
  }
  if (meta.hald && fs.existsSync(path.join(P.previous, 'hald'))) {
    fs.copyFileSync(path.join(P.previous, 'hald'), `${P.hald}.new`)
    fs.chmodSync(`${P.hald}.new`, 0o755)
    fs.renameSync(`${P.hald}.new`, P.hald)
  }
  if (meta.podvision === 'replaced' && fs.existsSync(path.join(P.previous, 'podvision'))) {
    fs.copyFileSync(path.join(P.previous, 'podvision'), `${P.podvision}.new`)
    fs.chmodSync(`${P.podvision}.new`, 0o755)
    fs.renameSync(`${P.podvision}.new`, P.podvision)
  }
  else if (meta.podvision === 'added') fs.rmSync(P.podvision, { force: true })
  pinVersion()
  return startAndCheck(meta, meta.fromVersion)
}

async function rollBack(meta, reason) {
  setStatus({ state: 'rolling-back', error: reason })
  log(`update failed: ${reason}; putting back ${meta.fromVersion ?? 'the previous version'}`)
  let r
  try {
    r = await putBack(meta)
    // Everything moved back; only the record is left.
    fs.rmSync(P.previous, { recursive: true, force: true })
  }
  catch (e) {
    // Leaves <prefix>.previous for seedypod-update --rollback over SSH.
    r = { ok: false, error: e.message }
  }
  if (r.ok) {
    log('the previous version is running again')
    setStatus({ state: 'rolled-back', error: reason, rolledBack: true })
  }
  else {
    log(`the previous version did not come back either: ${r.error}`)
    setStatus({ state: 'rollback-failed', error: `${reason}; the rollback failed too: ${r.error}`, rolledBack: false })
  }
}

async function apply() {
  const plan = readJson(PLAN)
  if (!plan?.release) throw new Error('nothing planned; run seedypod-update --start')
  const { release } = plan
  const acct = coreAccount()
  const fromVersion = installed().version
  setStatus({ op: 'update', state: 'downloading', channel: release.channel, from: installed(), to: { tag: release.tag, commit: release.commit }, error: undefined, rolledBack: undefined })
  log(`updating ${fromVersion ?? 'core'} to ${release.channel} ${release.tag} (${release.commit.slice(0, 7)})`)

  // 1. Download and check everything before the unit is touched.
  const tarball = await fetchAsset(release, 'seedypod-core.tar.gz')
  setStatus({ state: 'verifying' })
  await unpack(tarball)
  const to = gitInfo(P.next)
  // dev-latest moves its tag before it replaces the assets.
  if (to.commit && !release.commit.startsWith(to.commit)) throw new Refused('invalid', `the ${release.tag} release is still being published (its tarball is ${to.commit}, its tag ${release.commit.slice(0, 7)}); try again in a few minutes`)
  const deps = depsChanged(P.next)
  const sqlite = deps && os.machine() === 'armv6l' ? await sqlitePrebuilt(release, P.next) : null
  let hald = null
  if (updatesHald()) {
    const name = `hald-${haldTarget()}`
    const file = await fetchAsset(release, name)
    fs.chmodSync(file, 0o755)
    const ver = await run(file, ['--version'], { uid: acct.uid, gid: acct.gid })
    if (ver.code !== 0) throw new Refused('invalid', `${name} doesn't run on this machine`)
    if (!fs.readFileSync(file).equals(fs.readFileSync(P.hald))) hald = file
    log(hald ? `hald: ${ver.out.trim()}` : 'hald is unchanged')
  }
  // Core scores pods in TypeScript without podvision, so a release without one, or one
  // that won't run here, leaves what's installed as it is instead of refusing the update.
  let podvision = null
  const pvName = podvisionTarget() ? `podvision-${podvisionTarget()}` : null
  if (pvName && release.assets[pvName]) {
    const file = await fetchAsset(release, pvName)
    fs.chmodSync(file, 0o755)
    const ver = await run(file, ['--version'], { uid: acct.uid, gid: acct.gid })
    if (ver.code !== 0) log(`${pvName} doesn't run on this machine; podvision stays as it is`)
    else if (fs.existsSync(P.podvision) && fs.readFileSync(file).equals(fs.readFileSync(P.podvision))) log('podvision is unchanged')
    else {
      podvision = file
      log(`podvision: ${ver.out.trim()}`)
    }
  }
  // The helpers come from the checked release, before its files are handed to core's account.
  const helpers = path.join(DL, 'helpers')
  fs.mkdirSync(helpers, { recursive: true, mode: 0o700 })
  for (const n of ['seedypod-update.cjs', 'seedypod-restore.cjs']) fs.copyFileSync(path.join(P.next, 'scripts', n), path.join(helpers, n))
  for (const n of LOGIN_FILES) {
    const from = path.join(P.next, 'scripts/login-logo', n)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(helpers, n))
  }
  const halOnline = !!(await coreAnswer())?.halOnline

  // 2. Swap, keeping what it replaces in <prefix>.previous.
  setStatus({ state: 'stopping', to: { tag: release.tag, commit: release.commit, version: to.version } })
  log('stopping core')
  fs.rmSync(P.previous, { recursive: true, force: true })
  fs.mkdirSync(path.join(P.previous, 'code'), { recursive: true, mode: 0o755 })
  const meta = { at: new Date().toISOString(), fromVersion, toVersion: to.version, tag: release.tag, moved: [], placed: [], nodeModules: false, db: false, hald: false, podvision: false, halOnline }
  writeJson(META, meta)
  try {
    await systemctl('stop', 'seedypod-core')
    if (hald) await systemctl('stop', 'hald')
    setStatus({ state: 'swapping' })
    const data = path.join(P.prefix, 'data')
    if (DB_FILES.some(f => fs.existsSync(path.join(data, f)))) {
      fs.mkdirSync(path.join(P.previous, 'db'), { recursive: true, mode: 0o700 })
      for (const f of DB_FILES) if (fs.existsSync(path.join(data, f))) fs.copyFileSync(path.join(data, f), path.join(P.previous, 'db', f))
      meta.db = true
      writeJson(META, meta)
    }
    for (const n of fs.readdirSync(P.prefix)) {
      if (KEEP(n)) continue
      move(path.join(P.prefix, n), path.join(P.previous, 'code', n))
      meta.moved.push(n)
      writeJson(META, meta)
    }
    for (const n of fs.readdirSync(P.next)) {
      meta.placed.push(n)
      writeJson(META, meta)
      move(path.join(P.next, n), path.join(P.prefix, n))
      own(path.join(P.prefix, n), acct)
    }
    fs.rmSync(P.next, { recursive: true, force: true })
    log(`put ${to.version} in place; the previous version is in ${P.previous}`)
    if (deps) {
      setStatus({ state: 'installing' })
      if (fs.existsSync(path.join(P.prefix, 'node_modules'))) {
        move(path.join(P.prefix, 'node_modules'), path.join(P.previous, 'node_modules'))
        meta.nodeModules = true
        writeJson(META, meta)
      }
      await installDeps(acct, sqlite)
    }
    else log('dependencies unchanged')
    if (hald) {
      fs.copyFileSync(P.hald, path.join(P.previous, 'hald'))
      meta.hald = true
      writeJson(META, meta)
      fs.copyFileSync(hald, `${P.hald}.new`)
      fs.chmodSync(`${P.hald}.new`, 0o755)
      fs.renameSync(`${P.hald}.new`, P.hald)
    }
    if (podvision) {
      const had = fs.existsSync(P.podvision)
      if (had) fs.copyFileSync(P.podvision, path.join(P.previous, 'podvision'))
      meta.podvision = had ? 'replaced' : 'added'
      writeJson(META, meta)
      fs.mkdirSync(path.dirname(P.podvision), { recursive: true })
      fs.copyFileSync(podvision, `${P.podvision}.new`)
      fs.chmodSync(`${P.podvision}.new`, 0o755)
      fs.renameSync(`${P.podvision}.new`, P.podvision)
    }
    // Keyed on content, so stale entries are only dead weight.
    fs.rmSync(P.compileCache, { recursive: true, force: true })
  }
  catch (e) {
    await rollBack(meta, e.message)
    return { ok: false, code: 'rolled-back', error: e.message }
  }

  // 3. Start, and keep it only if it's healthy.
  const health = await startAndCheck(meta, to.version)
  if (!health.ok) {
    await rollBack(meta, health.error)
    return { ok: false, code: 'rolled-back', error: health.error }
  }
  for (const n of ['seedypod-update.cjs', 'seedypod-restore.cjs']) {
    try {
      installHelper(path.join(helpers, n), n.replace(/\.cjs$/, ''))
    }
    catch (e) {
      log(`couldn't refresh ${n}: ${e.message}`)
    }
  }
  refreshLogin(helpers)
  pinVersion()
  fs.rmSync(path.join(P.previous, 'db'), { recursive: true, force: true })
  meta.db = false
  writeJson(META, meta)
  writeJson(INSTALLED, { channel: release.channel, tag: release.tag, commit: release.commit, version: to.version, at: new Date().toISOString() })
  fs.rmSync(DL, { recursive: true, force: true })
  fs.rmSync(PLAN, { force: true })
  log(`updated to ${to.version} (${release.tag})`)
  setStatus({ state: 'done' })
  return { ok: true, version: to.version, tag: release.tag }
}

/** Runs the update after this process exits: stopping seedypod-core would stop a child of core with it. */
function detach() {
  const self = [process.execPath, __filename, '--apply']
  if (env('SEEDYPOD_UPDATE_DETACH') !== 'fork' && isRoot && fs.existsSync('/usr/bin/systemd-run')) {
    execFileSync('/usr/bin/systemd-run', ['--quiet', '--collect', `--unit=seedypod-update-${Date.now()}`, '--description=seedypod update (ADR-0026)', ...self])
    return
  }
  spawn(self[0], self.slice(1), { detached: true, stdio: 'ignore', env: process.env }).unref()
}

async function plan() {
  const c = await check()
  if (c.problem) throw new Refused('missing-asset', `can't update from ${c.release.tag}: ${c.problem}`)
  if (!c.updateAvailable) throw new Refused('current', `already on ${c.channel} ${c.available.tag} (${c.available.commit.slice(0, 7)})`)
  writeJson(PLAN, { at: new Date().toISOString(), release: c.release })
  fs.writeFileSync(LOG, '', { mode: 0o644 })
  current = {}
  setStatus({ op: 'update', state: 'queued', channel: c.channel, from: c.installed, to: { tag: c.available.tag, commit: c.available.commit } })
  return c
}

// ---- CLI ----------------------------------------------------------------------------------------

function result(code, obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exitCode = code
}

const USAGE = 'usage: seedypod-update --status | --channel stable|dev | --check | --start | --now | --rollback\n'
const RUNNING = new Set(['queued', 'downloading', 'verifying', 'stopping', 'swapping', 'installing', 'starting', 'health', 'rolling-back'])
const EXIT = { 'usage': 2, 'checksum': 4, 'invalid': 4, 'missing-asset': 4, 'current': 4, 'needs-install': 4, 'no-release': 4, 'busy': 5 }

function status() {
  return { ok: true, channel: channel(), installed: installed(), status: readJson(STATUS), previous: readJson(META) }
}

async function main(argv) {
  const [flag, arg, ...rest] = argv
  try {
    if (rest.length) throw new Refused('usage', 'too many arguments')
    if (flag === '--channel') {
      if (!Object.hasOwn(CHANNELS, arg ?? '')) throw new Refused('usage', 'the channel must be stable or dev')
      fs.mkdirSync(P.work, { recursive: true, mode: 0o755 })
      fs.writeFileSync(CHANNEL, `${arg}\n`, { mode: 0o644 })
      return result(0, { ok: true, channel: arg })
    }
    if (arg !== undefined) throw new Refused('usage', `${flag} takes no argument`)
    if (flag === '--status') return result(0, status())
    if (flag === '--check') {
      const c = await check()
      delete c.release
      return result(0, { ok: true, ...c })
    }
    if (flag === '--start') {
      const st = readJson(STATUS)
      if (st && RUNNING.has(st.state) && Date.now() - Date.parse(st.at) < 2 * 3600_000) throw new Refused('busy', 'an update is already running')
      lock()
      try {
        const c = await plan()
        detach()
        return result(0, { ok: true, detached: true, channel: c.channel, to: c.available })
      }
      finally {
        unlock()
      }
    }
    if (flag === '--apply' || flag === '--now') {
      lock()
      try {
        if (flag === '--now') await plan()
      }
      catch (e) {
        unlock()
        throw e
      }
      markBusy(true)
      try {
        current = readJson(STATUS) ?? {}
        const r = await apply()
        return result(r.ok ? 0 : 1, r)
      }
      catch (e) {
        // Before anything moved: nothing to put back, and core was never stopped.
        setStatus({ state: e instanceof Refused ? 'refused' : 'failed', code: e.code, error: e.message })
        throw e
      }
      finally {
        fs.rmSync(P.next, { recursive: true, force: true })
        markBusy(false)
        unlock()
      }
    }
    if (flag === '--rollback') {
      const meta = readJson(META)
      if (!meta) throw new Refused('invalid', 'there is no previous version to put back')
      lock()
      try {
        current = { op: 'rollback' }
        await rollBack(meta, 'rolled back by hand')
        return result(0, { ok: true, status: readJson(STATUS) })
      }
      finally {
        unlock()
      }
    }
    throw new Refused('usage', flag ? `unknown option ${flag}` : 'no option given')
  }
  catch (e) {
    if (e instanceof Refused) {
      if (e.code === 'usage') process.stderr.write(USAGE)
      process.stderr.write(`${e.message}\n`)
      return result(EXIT[e.code] ?? 4, { ok: false, code: e.code, error: e.message })
    }
    process.stderr.write(`update failed: ${e.message}\n`)
    return result(1, { ok: false, code: 'failed', error: e.message })
  }
}

if (require.main === module) void main(process.argv.slice(2))
