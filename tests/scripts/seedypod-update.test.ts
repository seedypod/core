/**
 * The update helper (ADR-0026), run as core runs it, against a scratch prefix,
 * a stub systemctl and pnpm, and a local server that stands in for GitHub's
 * API, its release downloads, and core's health check.
 */
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Each test runs the helper several times, and the whole suite runs at once in CI.
vi.setConfig({ testTimeout: 30_000 })

const helper = resolve(import.meta.dirname, '../../scripts/seedypod-update.cjs')
const OLD = 'aaaaaaa'
const NEW = 'bbbbbbb'
const SHA = `${NEW}${'c'.repeat(33)}`
const LOCK = 'lockfileVersion: \'9.0\'\n\npackages:\n\n  better-sqlite3@12.6.2:\n    resolution: {}\n'

let dir: string
let prefix: string
let server: Server
let base: string
/** What the fake GitHub serves: asset name → bytes, and the release's digests. */
let assets: Map<string, Buffer>
let digests: Map<string, string>
let releaseCommit: string
let envs: Record<string, string>

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const p = (rel: string) => join(prefix, rel)
const read = (rel: string) => readFileSync(p(rel), 'utf8')

function put(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

function tree(commit: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    '.git-info': JSON.stringify({ branch: 'dev', commitHash: commit }),
    '.node-version': `${process.versions.node.split('.')[0]}\n`,
    'package.json': '{"name":"@seedypod/core"}',
    'pnpm-lock.yaml': LOCK,
    'server/dist/index.js': `core ${commit}`,
    'web/dist/index.html': `<p>${commit}</p>`,
    'scripts/install': `NODE_22=${process.versions.node}\n`,
    'scripts/seedypod-update.cjs': `// update helper ${commit}, prefix __PREFIX__\n`,
    'scripts/seedypod-restore.cjs': `// restore helper ${commit}, prefix __PREFIX__\n`,
    ...overrides,
  }
}

/** A release tarball the way CI makes one: `tar czf … .` of the built tree. */
function release(files: Record<string, string>, opts: { sumFile?: boolean | string, digest?: boolean | string } = {}) {
  const src = mkdtempSync(join(dir, 'src-'))
  put(src, files)
  const out = join(dir, `release-${Math.random().toString(36).slice(2)}.tar.gz`)
  const r = spawnSync('tar', ['-czf', out, '-C', src, '.'])
  expect(r.status).toBe(0)
  const bytes = readFileSync(out)
  assets.set('seedypod-core.tar.gz', bytes)
  const { sumFile = true, digest = true } = opts
  if (sumFile) assets.set('seedypod-core.tar.gz.sha256', Buffer.from(`${typeof sumFile === 'string' ? sumFile : sha(bytes)}  seedypod-core.tar.gz\n`))
  else assets.delete('seedypod-core.tar.gz.sha256')
  if (digest) digests.set('seedypod-core.tar.gz', typeof digest === 'string' ? digest : sha(bytes))
  else digests.delete('seedypod-core.tar.gz')
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seedypod-update-'))
  prefix = join(dir, 'opt/seedypod')
  put(prefix, {
    ...tree(OLD),
    'data/seedypod.db': 'SQLite format 3\0old',
    [`node_modules/.seedypod-lock-${process.version}`]: LOCK,
    'node_modules/better-sqlite3/package.json': '{"name":"better-sqlite3","main":"index.js"}',
    'node_modules/better-sqlite3/index.js': 'module.exports = class { exec() {} }\n',
    '.env': 'KEEP=1\n',
  })
  assets = new Map()
  digests = new Map()
  releaseCommit = SHA
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (o: unknown, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    const tag = url.pathname.endsWith('/releases/latest') ? 'v1.2.0' : url.pathname.endsWith('/releases/tags/dev-latest') ? 'dev-latest' : null
    if (tag) {
      return json({
        tag_name: tag,
        name: tag === 'v1.2.0' ? 'v1.2.0' : 'Dev (latest)',
        published_at: '2026-11-08T00:00:00Z',
        html_url: `https://github.com/seedypod/core/releases/tag/${tag}`,
        assets: [...assets.keys()].map(name => ({ name, size: assets.get(name)?.length, browser_download_url: `${base}/dl/${name}`, digest: digests.has(name) ? `sha256:${digests.get(name)}` : null })),
      })
    }
    if (url.pathname.startsWith('/repos/seedypod/core/commits/')) return res.end(releaseCommit)
    if (url.pathname.startsWith('/dl/')) {
      const body = assets.get(url.pathname.slice(4))
      if (!body) return json({}, 404)
      return res.end(body)
    }
    // Core, as whatever is in the prefix: a build that says "broken" never answers.
    if (url.pathname === '/core/api/healthcheck' || url.pathname === '/core/api/system') {
      const code = existsSync(p('server/dist/index.js')) ? read('server/dist/index.js') : ''
      if (code.includes('broken') || existsSync(join(dir, 'core-stopped'))) return json({}, 503)
      const info = JSON.parse(read('.git-info')) as { branch: string, commitHash: string }
      return json(url.pathname.endsWith('healthcheck') ? { ok: true } : { coreVersion: `${info.branch}@${info.commitHash}`, halOnline: false })
    }
    json({}, 404)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // systemctl: logs, and a broken build "migrates" the database when it starts.
  const systemctl = join(dir, 'systemctl.mjs')
  writeFileSync(systemctl, `import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
const [verb, unit] = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'systemctl.log'))}, verb + ' ' + unit + '\\n')
if (unit === 'seedypod-core' && verb === 'stop') writeFileSync(${JSON.stringify(join(dir, 'core-stopped'))}, '')
if (unit === 'seedypod-core' && verb === 'start') {
  rmSync(${JSON.stringify(join(dir, 'core-stopped'))}, { force: true })
  if (readFileSync(${JSON.stringify(p('server/dist/index.js'))}, 'utf8').includes('broken')) writeFileSync(${JSON.stringify(p('data/seedypod.db'))}, 'SQLite format 3\\0migrated')
}
`)
  // pnpm: logs, then links a better-sqlite3 that loads, unless told to fail.
  const pnpm = join(dir, 'pnpm.mjs')
  writeFileSync(pnpm, `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(dir, 'pnpm.log'))}, process.argv.slice(2).join(' ') + ' in ' + process.cwd() + '\\n')
writeFileSync(${JSON.stringify(join(dir, 'pnpm.prompt'))}, String(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT))
if (existsSync(${JSON.stringify(join(dir, 'pnpm-fails'))})) process.exit(1)
mkdirSync('node_modules/better-sqlite3', { recursive: true })
writeFileSync('node_modules/better-sqlite3/package.json', '{"name":"better-sqlite3","main":"index.js"}')
writeFileSync('node_modules/better-sqlite3/index.js', 'module.exports = class { exec() {} }')
writeFileSync('node_modules/fresh', '')
`)
  writeFileSync(join(dir, 'core.service'), '[Service]\nEnvironment=NODE_ENV=production PORT=3000\nUser=nobody\n')
  envs = {
    SEEDYPOD_UPDATE_PREFIX: prefix,
    SEEDYPOD_UPDATE_WORK: join(dir, 'work'),
    SEEDYPOD_UPDATE_API: base,
    SEEDYPOD_UPDATE_DOWNLOADS: `${base}/dl/`,
    SEEDYPOD_UPDATE_CORE_UNIT: join(dir, 'core.service'),
    SEEDYPOD_UPDATE_HALD_UNIT: join(dir, 'no-hald.service'),
    SEEDYPOD_UPDATE_CORE_URL: `${base}/core`,
    SEEDYPOD_UPDATE_HEALTH_TIMEOUT: '15',
    SEEDYPOD_UPDATE_POLL_MS: '50',
    SEEDYPOD_UPDATE_SBIN: join(dir, 'sbin'),
    SEEDYPOD_UPDATE_COMPILE_CACHE: join(dir, 'cache/compile-cache'),
    SEEDYPOD_UPDATE_BUSY: join(dir, 'run/seedypod-busy'),
    SEEDYPOD_UPDATE_PNPM: JSON.stringify([process.execPath, pnpm]),
    SEEDYPOD_UPDATE_DETACH: 'fork',
    SEEDYPOD_SYSTEMCTL: JSON.stringify([process.execPath, systemctl]),
  }
})

afterEach(async () => {
  await new Promise(r => server.close(r))
  rmSync(dir, { recursive: true, force: true })
})

/** Async, so the fake GitHub in this process can answer. */
function run(...args: string[]): Promise<{ code: number, out: Record<string, unknown>, err: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [helper, ...args], { env: { ...process.env, ...envs }, timeout: 30_000 }, (err, stdout, stderr) => {
      const last = stdout.trim().split('\n').at(-1) || '{}'
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: JSON.parse(last) as Record<string, unknown>, err: stderr })
    })
  })
}

const work = (f: string) => join(dir, 'work', f)
const status = () => JSON.parse(readFileSync(work('status.json'), 'utf8')) as Record<string, unknown>
const calls = () => (existsSync(join(dir, 'systemctl.log')) ? readFileSync(join(dir, 'systemctl.log'), 'utf8').trim().split('\n') : [])

describe('arguments', () => {
  it('rejects a channel that is not stable or dev, and keeps the one it had', async () => {
    expect(await run('--channel', 'dev')).toMatchObject({ code: 0, out: { ok: true, channel: 'dev' } })
    for (const junk of ['nightly', 'dev; rm -rf /', '', '--now', 'STABLE']) {
      const r = await run('--channel', junk)
      expect(r.code).toBe(2)
      expect(r.out).toMatchObject({ ok: false, code: 'usage', error: 'the channel must be stable or dev' })
    }
    expect((await run('--channel')).code).toBe(2)
    expect(readFileSync(work('channel'), 'utf8').trim()).toBe('dev')
  })

  it('rejects unknown options and extra arguments', async () => {
    for (const args of [[], ['--update'], ['--start', 'dev'], ['--check', 'x'], ['--channel', 'dev', 'extra'], ['https://evil.example/core.tar.gz']]) {
      const r = await run(...args)
      expect(r.code).toBe(2)
      expect(r.out).toMatchObject({ ok: false, code: 'usage' })
    }
    expect(calls()).toEqual([])
  })

  it('remembers the channel, and starts from the installed branch', async () => {
    expect((await run('--status')).out).toMatchObject({ channel: 'dev', installed: { version: `dev@${OLD}`, commit: OLD } })
    await run('--channel', 'stable')
    expect((await run('--status')).out).toMatchObject({ channel: 'stable' })
  })
})

describe('checking', () => {
  it('says what the channel has and whether it is newer', async () => {
    release(tree(NEW))
    const r = await run('--check')
    expect(r.code).toBe(0)
    expect(r.out).toMatchObject({ ok: true, channel: 'dev', installed: { commit: OLD }, available: { tag: 'dev-latest', commit: SHA }, updateAvailable: true, problem: null })
    await run('--channel', 'stable')
    expect((await run('--check')).out).toMatchObject({ channel: 'stable', available: { tag: 'v1.2.0' } })
  })

  it('reports a release with no checksum at all, and refuses to start from it', async () => {
    release(tree(NEW), { sumFile: false, digest: false })
    expect((await run('--check')).out).toMatchObject({ problem: 'the release has no checksum for seedypod-core.tar.gz' })
    const r = await run('--start')
    expect(r).toMatchObject({ code: 4, out: { code: 'missing-asset' } })
    expect(calls()).toEqual([])
  })

  it('has nothing to do on the build already installed', async () => {
    releaseCommit = `${OLD}${'d'.repeat(33)}`
    release(tree(OLD))
    expect((await run('--check')).out).toMatchObject({ updateAvailable: false })
    expect(await run('--start')).toMatchObject({ code: 4, out: { code: 'current' } })
  })
})

describe('updating', () => {
  it('swaps in the release, keeps the previous version, and refreshes the helpers', async () => {
    release(tree(NEW))
    const r = await run('--now')
    expect(r.err).toContain('matches')
    expect(r).toMatchObject({ code: 0, out: { ok: true, version: `dev@${NEW}`, tag: 'dev-latest' } })
    expect(read('server/dist/index.js')).toBe(`core ${NEW}`)
    expect(read('data/seedypod.db')).toContain('old')
    expect(read('.env')).toBe('KEEP=1\n')
    expect(readFileSync(`${prefix}.previous/code/server/dist/index.js`, 'utf8')).toBe(`core ${OLD}`)
    expect(existsSync(`${prefix}.previous/db`)).toBe(false)
    expect(existsSync(`${prefix}.next`)).toBe(false)
    expect(calls()).toEqual(['stop seedypod-core', 'start seedypod-core'])
    expect(status()).toMatchObject({ op: 'update', state: 'done', channel: 'dev', from: { commit: OLD }, to: { tag: 'dev-latest', commit: SHA } })
    expect(readFileSync(join(dir, 'sbin/seedypod-update'), 'utf8')).toBe(`// update helper ${NEW}, prefix ${prefix}\n`)
    expect(readFileSync(join(dir, 'sbin/seedypod-restore'), 'utf8')).toContain(`restore helper ${NEW}`)
    expect(existsSync(join(dir, 'pnpm.log'))).toBe(false)
    expect(readFileSync(work('update.log'), 'utf8')).toContain('dependencies unchanged')
    expect((await run('--status')).out).toMatchObject({ installed: { commit: NEW, tag: 'dev-latest' } })
    expect(existsSync(join(dir, 'run/seedypod-busy/update'))).toBe(false)
  })

  it('aborts on a checksum mismatch before stopping anything', async () => {
    release(tree(NEW), { sumFile: 'f'.repeat(64) })
    const r = await run('--now')
    expect(r.code).toBe(4)
    expect(r.out).toMatchObject({ ok: false, code: 'checksum' })
    expect(r.out.error).toMatch(/^seedypod-core\.tar\.gz doesn't match the release's checksum file/)
    expect(read('server/dist/index.js')).toBe(`core ${OLD}`)
    expect(calls()).toEqual([])
    expect(status()).toMatchObject({ state: 'refused', code: 'checksum' })
    expect(existsSync(`${prefix}.previous`)).toBe(false)
  })

  it('also holds the download to GitHub\'s digest', async () => {
    release(tree(NEW), { digest: 'e'.repeat(64) })
    const r = await run('--now')
    expect(r.out).toMatchObject({ code: 'checksum' })
    expect(r.out.error).toMatch(/doesn't match GitHub's digest/)
    expect(calls()).toEqual([])
  })

  it('rolls back when the new version fails its health check, database included', async () => {
    release(tree(NEW, { 'server/dist/index.js': 'core broken' }))
    envs.SEEDYPOD_UPDATE_HEALTH_TIMEOUT = '1'
    const r = await run('--now')
    expect(r.code).toBe(1)
    expect(r.out).toMatchObject({ ok: false, code: 'rolled-back' })
    expect(read('server/dist/index.js')).toBe(`core ${OLD}`)
    expect(JSON.parse(read('.git-info'))).toMatchObject({ commitHash: OLD })
    expect(read('data/seedypod.db')).toBe('SQLite format 3\0old')
    expect(calls()).toEqual(['stop seedypod-core', 'start seedypod-core', 'stop seedypod-core', 'start seedypod-core'])
    expect(status()).toMatchObject({ state: 'rolled-back', rolledBack: true })
    expect(String(status().error)).toMatch(/core did not answer within 1 s/)
    expect(existsSync(`${prefix}.previous`)).toBe(false)
    expect(existsSync(join(dir, 'sbin/seedypod-update'))).toBe(false)
  })

  it('installs changed dependencies as core, and puts the old ones back if that fails', async () => {
    release(tree(NEW, { 'pnpm-lock.yaml': `${LOCK}\n  zod@4.1.0:\n    resolution: {}\n` }))
    const ok = await run('--now')
    expect(ok.out).toMatchObject({ ok: true })
    // cwd is the real path, which on macOS is under /private.
    expect(readFileSync(join(dir, 'pnpm.log'), 'utf8')).toMatch(/^install --prod --frozen-lockfile in .*\/opt\/seedypod\n$/)
    // Corepack must not stop to ask before downloading a newer pinned pnpm.
    expect(readFileSync(join(dir, 'pnpm.prompt'), 'utf8')).toBe('0')
    expect(existsSync(p('node_modules/fresh'))).toBe(true)
    expect(read(`node_modules/.seedypod-lock-${process.version}`)).toContain('zod@4.1.0')
    expect(existsSync(`${prefix}.previous/node_modules/.seedypod-lock-${process.version}`)).toBe(true)

    // The next release changes them again, and pnpm fails: everything goes back.
    releaseCommit = `${'9'.repeat(7)}${'c'.repeat(33)}`
    release(tree('9999999', { 'pnpm-lock.yaml': `${LOCK}\n  hono@4.9.0:\n    resolution: {}\n` }))
    writeFileSync(join(dir, 'pnpm-fails'), '')
    const bad = await run('--now')
    expect(bad.out).toMatchObject({ ok: false, code: 'rolled-back', error: 'pnpm install failed (exit 1)' })
    expect(read('server/dist/index.js')).toBe(`core ${NEW}`)
    expect(read(`node_modules/.seedypod-lock-${process.version}`)).toContain('zod@4.1.0')
    expect(status()).toMatchObject({ state: 'rolled-back' })
  })

  it('refuses a tarball from another commit than the release tag', async () => {
    release(tree('1234567'))
    const r = await run('--now')
    expect(r.out).toMatchObject({ ok: false, code: 'invalid' })
    expect(r.out.error).toMatch(/still being published/)
    expect(read('server/dist/index.js')).toBe(`core ${OLD}`)
    expect(calls()).toEqual([])
  })

  it('refuses a release built for another Node', async () => {
    release(tree(NEW, { '.node-version': '99\n', 'scripts/install': 'NODE_22=99.0.0\n' }))
    const r = await run('--now')
    expect(r.out).toMatchObject({ ok: false, code: 'needs-install' })
    expect(calls()).toEqual([])
  })

  it('refuses a release from before updates from the web, and one missing its build', async () => {
    const old = tree(NEW)
    delete old['scripts/seedypod-update.cjs']
    release(old)
    expect((await run('--now')).out).toMatchObject({ code: 'needs-install', error: 'this release is older than updating from the web; install it over SSH with scripts/install' })
    const unbuilt = tree(NEW)
    delete unbuilt['server/dist/index.js']
    release(unbuilt)
    expect((await run('--now')).out).toMatchObject({ code: 'invalid', error: 'the release is missing server/dist/index.js' })
    expect(calls()).toEqual([])
  })

  it('refuses while another update holds the lock', async () => {
    release(tree(NEW))
    mkdirSync(join(dir, 'work'), { recursive: true })
    writeFileSync(work('lock'), String(process.pid))
    expect(await run('--now')).toMatchObject({ code: 5, out: { code: 'busy' } })
    expect(await run('--start')).toMatchObject({ code: 5, out: { code: 'busy' } })
  })

  it('runs detached from --start, as core calls it', async () => {
    release(tree(NEW))
    const r = await run('--start')
    expect(r).toMatchObject({ code: 0, out: { ok: true, detached: true, channel: 'dev', to: { tag: 'dev-latest' } } })
    for (let i = 0; i < 400 && status().state !== 'done'; i++) await new Promise(res => setTimeout(res, 50))
    expect(status()).toMatchObject({ state: 'done' })
    expect(read('server/dist/index.js')).toBe(`core ${NEW}`)
    expect(await run('--start')).toMatchObject({ code: 4, out: { code: 'current' } })
  })

  it('puts the previous version back by hand with --rollback', async () => {
    release(tree(NEW))
    await run('--now')
    chmodSync(prefix, 0o755)
    const r = await run('--rollback')
    expect(r).toMatchObject({ code: 0 })
    expect(read('server/dist/index.js')).toBe(`core ${OLD}`)
    expect(status()).toMatchObject({ state: 'rolled-back' })
    expect(await run('--rollback')).toMatchObject({ code: 4, out: { code: 'invalid' } })
  })
})
