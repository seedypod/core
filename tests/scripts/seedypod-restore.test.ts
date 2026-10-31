/**
 * The restore helper (ADR-0021), run as core runs it, against a scratch
 * filesystem with a stub systemctl. Bundles come from core's own writer.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundleEntries, collect, gzipTar, type BackupManifest, type BundleFile } from '../../src/backup/bundle'
import { header } from '../../src/datasets/tar'

const helper = resolve(import.meta.dirname, '../../scripts/seedypod-restore.cjs')
const enc = new TextEncoder()
const DB = (tag: string) => enc.encode(`SQLite format 3\0${tag}`)

let dir: string
let live: (p: string) => string
let envs: Record<string, string>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seedypod-restore-'))
  live = p => join(dir, 'live', p)
  for (const d of ['data', 'etc', 'state', 'mosquitto', 'migrations/meta']) mkdirSync(live(d), { recursive: true })
  writeFileSync(live('data/seedypod.db'), DB('old'))
  writeFileSync(live('data/seedypod.db-wal'), 'old wal')
  writeFileSync(live('etc/hal.toml'), 'unit_id = "fresh"\n')
  writeFileSync(live('state/state.json'), '{"fresh":true}')
  writeFileSync(live('state/sensors.json'), '[]')
  writeFileSync(live('mosquitto/seedypod.conf'), 'per_listener_settings true\nlistener 1883 127.0.0.1\n')
  writeFileSync(live('migrations/meta/_journal.json'), JSON.stringify({ entries: Array.from({ length: 7 }, (_, i) => ({ tag: `000${i}_x` })) }))
  const stub = join(dir, 'systemctl.mjs')
  writeFileSync(stub, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(dir, 'systemctl.log'))}, process.argv.slice(2).join(' ') + '\\n')\n`)
  envs = {
    SEEDYPOD_RESTORE_DB: live('data/seedypod.db'),
    SEEDYPOD_RESTORE_CAPTURES: live('data/captures'),
    SEEDYPOD_RESTORE_JOURNAL: live('migrations/meta/_journal.json'),
    SEEDYPOD_ETC_DIR: live('etc'),
    SEEDYPOD_STATE_DIR: live('state'),
    SEEDYPOD_MOSQUITTO_PASSWD: live('mosquitto/seedypod.passwd'),
    SEEDYPOD_MOSQUITTO_CONF: live('mosquitto/seedypod.conf'),
    SEEDYPOD_RESTORE_WORK: join(dir, 'work'),
    SEEDYPOD_SYSTEMCTL: JSON.stringify([process.execPath, stub]),
    SEEDYPOD_RESTORE_DETACH: 'fork',
  }
})

afterEach(() => {
  chmodSync(live('etc'), 0o755)
  rmSync(dir, { recursive: true, force: true })
})

const meta = (o: Partial<BackupManifest> = {}): Omit<BackupManifest, 'files'> => ({
  format: { name: 'seedypod-backup', version: 1 },
  createdAt: '2026-10-31T03:00:00.000Z',
  unit: { id: 'kitchen', name: 'Kitchen' },
  core: { version: 'main@abc1234' },
  hald: { version: '1.3.0' },
  schema: { migrations: 7, tag: '0006_x' },
  photos: false,
  skipped: [],
  ...o,
})

const FILES: BundleFile[] = [
  { name: 'seedypod.db', bytes: DB('restored') },
  { name: 'etc/seedypod/hal.toml', bytes: enc.encode('unit_id = "kitchen"\n') },
  { name: 'etc/mosquitto/seedypod.passwd', bytes: enc.encode('homeassistant:$7$101$abc\n') },
  { name: 'var/lib/seedypod/state.json', bytes: enc.encode('{"light":40}') },
]

async function bundle(files = FILES, m = meta()): Promise<string> {
  const p = join(dir, `bundle-${Math.random().toString(36).slice(2)}.tar.gz`)
  writeFileSync(p, await collect(gzipTar(bundleEntries(files, m))))
  return p
}

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', env: { ...process.env, ...envs } })
  const last = r.stdout.trim().split('\n').at(-1) ?? '{}'
  return { code: r.status, out: JSON.parse(last) as Record<string, unknown>, err: r.stderr }
}

const read = (p: string) => readFileSync(live(p), 'utf8')
const calls = () => (existsSync(join(dir, 'systemctl.log')) ? readFileSync(join(dir, 'systemctl.log'), 'utf8').trim().split('\n') : [])

describe('checking a bundle', () => {
  it('accepts a bundle from this schema and leaves the unit alone', async () => {
    const r = run('--check', await bundle())
    expect(r.code).toBe(0)
    expect(r.out).toMatchObject({ ok: true, bundle: { unit: { id: 'kitchen' }, core: 'main@abc1234', schema: 7 } })
    expect(read('data/seedypod.db')).toContain('old')
    expect(calls()).toEqual([])
  })

  it('refuses a bundle from a newer schema and names the version to install', async () => {
    const r = run(await bundle(FILES, meta({ schema: { migrations: 9, tag: '0008_y' }, core: { version: 'main@fff0000' } })))
    expect(r.code).toBe(3)
    expect(r.out).toMatchObject({ ok: false, code: 'newer-schema' })
    expect(r.out.error).toBe('This backup was made by seedypod core main@fff0000 (database schema 9); this unit\'s core has schema 7. Install that version of core or newer first (scripts/install), then restore again.')
    expect(read('data/seedypod.db')).toContain('old')
    expect(calls()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'work/status.json'), 'utf8'))).toMatchObject({ state: 'refused', code: 'newer-schema' })
  })

  it('refuses a damaged file', async () => {
    const p = await bundle()
    const good = await collect(gzipTar(bundleEntries(FILES, meta())))
    const tar = new Uint8Array(await new Response(new Blob([good as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    tar[512 + 20] ^= 0xFF // a byte of seedypod.db
    writeFileSync(p, gzipSync(tar))
    const r = run('--check', p)
    expect(r.code).toBe(4)
    expect(r.out.error).toBe('seedypod.db doesn\'t match its checksum; the file is damaged')
  })

  it('refuses files outside the allowed paths, links, and things that are not bundles', async () => {
    const tarOf = (name: string, type = '0', body = 'x') => {
      const h = header(name, body.length, 0)
      h[156] = type.charCodeAt(0)
      h.fill(0x20, 148, 156)
      const sum = h.reduce((n, b) => n + b, 0)
      h.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
      const data = new Uint8Array(512)
      data.set(enc.encode(body))
      return gzipSync(Buffer.concat([h, data, new Uint8Array(1024)]))
    }
    const write = (b: Uint8Array) => {
      const p = join(dir, `x-${Math.random()}.tar.gz`)
      writeFileSync(p, b)
      return p
    }
    expect(run('--check', write(tarOf('etc/passwd'))).out.error).toBe('unexpected file in the bundle: etc/passwd')
    expect(run('--check', write(tarOf('captures/../../etc/shadow'))).out.error).toBe('unexpected file in the bundle: captures/../../etc/shadow')
    expect(run('--check', write(tarOf('seedypod.db', '2'))).out.error).toBe('seedypod.db is not a regular file (tar type "2")')
    expect(run('--check', write(enc.encode('not a gzip'))).out.error).toMatch(/^not a seedypod backup/)
    expect(run('--check', join(dir, 'missing.tar.gz')).out.error).toMatch(/^no such file/)
    expect(run('--check', await bundle(FILES.slice(1))).out.error).toBe('the bundle has no database')
    expect(run().code).toBe(2)
  })
})

it('as installed, reads the schema from the prefix scripts/install wrote into it', async () => {
  const prefix = join(dir, 'opt/seedypod')
  mkdirSync(join(prefix, 'src/db/migrations/meta'), { recursive: true })
  writeFileSync(join(prefix, 'src/db/migrations/meta/_journal.json'), JSON.stringify({ entries: [{ tag: '0000_a' }, { tag: '0001_b' }] }))
  const installed = join(dir, 'seedypod-restore')
  writeFileSync(installed, readFileSync(helper, 'utf8').replace('__PREFIX__', prefix))
  const rest = { ...envs }
  delete rest.SEEDYPOD_RESTORE_JOURNAL
  const r = spawnSync(process.execPath, [installed, '--check', await bundle()], { encoding: 'utf8', env: { ...process.env, ...rest } })
  expect(r.status).toBe(3)
  expect(r.stderr).toContain('this unit\'s core has schema 2')
})

describe('restoring', () => {
  it('replaces the database, config, password and state, keeping the old files for undo', async () => {
    const r = run(await bundle())
    expect(r.code).toBe(0)
    expect(calls()).toEqual(['stop seedypod-core', 'stop hald', 'try-restart mosquitto', 'start hald', 'start seedypod-core'])
    expect(read('data/seedypod.db')).toContain('restored')
    expect(existsSync(live('data/seedypod.db-wal'))).toBe(false)
    expect(read('etc/hal.toml')).toBe('unit_id = "kitchen"\n')
    expect(read('mosquitto/seedypod.passwd')).toContain('homeassistant:')
    expect(read('state/state.json')).toBe('{"light":40}')
    // A state file the backup didn't have would describe a different unit.
    expect(existsSync(live('state/sensors.json'))).toBe(false)
    expect(read('mosquitto/seedypod.conf')).toMatch(/listener 1884\nallow_anonymous false\npassword_file .*seedypod\.passwd\n$/)
    const pre = (p: string) => readFileSync(join(dir, 'work/pre-restore', p), 'utf8')
    expect(pre('data/seedypod.db')).toContain('old')
    expect(pre('data/seedypod.db-wal')).toBe('old wal')
    expect(pre('etc/seedypod/hal.toml')).toContain('fresh')
    expect(JSON.parse(readFileSync(join(dir, 'work/undo.json'), 'utf8'))).toMatchObject({ bundle: { createdAt: '2026-10-31T03:00:00.000Z', unit: { id: 'kitchen' } }, undoneAt: null })
    expect(JSON.parse(readFileSync(join(dir, 'work/status.json'), 'utf8'))).toMatchObject({ op: 'restore', state: 'done' })
    expect(existsSync(join(dir, 'work/staging'))).toBe(false)
  })

  it('undoes a wrong restore, and a second undo redoes it', async () => {
    run(await bundle())
    expect(run('--undo').code).toBe(0)
    expect(read('data/seedypod.db')).toContain('old')
    expect(read('data/seedypod.db-wal')).toBe('old wal')
    expect(read('etc/hal.toml')).toContain('fresh')
    expect(read('state/sensors.json')).toBe('[]')
    expect(existsSync(live('mosquitto/seedypod.passwd'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'work/undo.json'), 'utf8')).undoneAt).toBeTruthy()
    expect(run('--undo').code).toBe(0)
    expect(read('data/seedypod.db')).toContain('restored')
    expect(existsSync(live('state/sensors.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'work/undo.json'), 'utf8')).undoneAt).toBeNull()
  })

  it('keeps the previous pre-restore until the next restore succeeds', async () => {
    run(await bundle())
    run(await bundle([{ name: 'seedypod.db', bytes: DB('second') }]))
    expect(read('data/seedypod.db')).toContain('second')
    expect(readFileSync(join(dir, 'work/pre-restore/data/seedypod.db'), 'utf8')).toContain('restored')
    // That bundle had no hal.toml or state, so those were left as they were.
    expect(read('etc/hal.toml')).toBe('unit_id = "kitchen"\n')
    expect(read('state/state.json')).toBe('{"light":40}')
  })

  it('puts everything back and restarts the services when a step fails', async () => {
    const p = await bundle()
    chmodSync(live('etc'), 0o555)
    const r = run(p)
    expect(r.code).toBe(1)
    expect(read('data/seedypod.db')).toContain('old')
    expect(read('data/seedypod.db-wal')).toBe('old wal')
    expect(read('etc/hal.toml')).toContain('fresh')
    expect(calls().slice(-2)).toEqual(['start hald', 'start seedypod-core'])
    expect(JSON.parse(readFileSync(join(dir, 'work/status.json'), 'utf8'))).toMatchObject({ state: 'failed' })
    expect(run('--undo').out).toMatchObject({ ok: false, error: 'there is no restore to undo' })
  })

  it('restores photos when the bundle has them, moving the old ones aside', async () => {
    mkdirSync(live('data/captures'))
    writeFileSync(live('data/captures/upper-old.jpg'), 'old')
    run(await bundle([...FILES, { name: 'captures/upper-1.jpg', bytes: enc.encode('jpeg') }], meta({ photos: true })))
    expect(read('data/captures/upper-1.jpg')).toBe('jpeg')
    expect(existsSync(live('data/captures/upper-old.jpg'))).toBe(false)
    expect(readFileSync(join(dir, 'work/pre-restore/data/captures/upper-old.jpg'), 'utf8')).toBe('old')
  })

  it('--detach returns at once and finishes in the background', async () => {
    const r = run('--detach', await bundle())
    expect(r.out).toMatchObject({ ok: true, detached: true })
    const status = () => JSON.parse(readFileSync(join(dir, 'work/status.json'), 'utf8')) as { state: string }
    for (let i = 0; i < 100 && status().state !== 'done'; i++) await new Promise(res => setTimeout(res, 50))
    expect(status().state).toBe('done')
    expect(read('data/seedypod.db')).toContain('restored')
  })
})
