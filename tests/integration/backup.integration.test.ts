import { serve } from '@hono/node-server'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app'
import { RestoreClient } from '../../src/backup/restore'
import { BackupService } from '../../src/backup/service'
import { untar } from '../../src/backup/tests/untar'
import { SimHal } from '../../src/hardware/sim'
import { createEventBus } from '../../src/lib/eventBus'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'

let base = ''
let close: () => void = () => undefined
let store: MemoryStore
let dir: string
const bucket = new Map<string, Uint8Array>()

/** A stand-in for the root helper: answers from answer.json and records what it was given. */
function helper(): string[] {
  const script = join(dir, 'helper.mjs')
  writeFileSync(script, `import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'args.log'))}, args.join(' ') + '\\n')
const bundle = args.find(a => a.endsWith('.tar.gz'))
if (bundle && existsSync(bundle)) copyFileSync(bundle, ${JSON.stringify(join(dir, 'seen'))})
const a = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'answer.json'))}, 'utf8'))
console.log(JSON.stringify(a.out))
process.exit(a.exit)
`)
  return [process.execPath, script]
}
const answer = (out: object, exit = 0) => writeFileSync(join(dir, 'answer.json'), JSON.stringify({ out, exit }))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'backup-http-'))
  const hal = new SimHal({ tickMs: 0, unitId: 'bench' })
  const events = createEventBus()
  store = new MemoryStore()
  const backup = new BackupService({
    store, hal, events, version: 'test',
    bucket: () => ({
      list: async () => [...bucket.keys()].map(key => ({ key, size: 3, lastModified: '2026-10-31T03:00:00.000Z' })),
      get: async key => bucket.get(key) ?? null,
      remove: async key => void bucket.delete(key),
    }),
    sources: {
      paths: { etcDir: '/etc/seedypod', stateDir: '/var/lib/seedypod', mosquittoPasswd: '/nope', capturesDir: './data/captures' },
      database: async () => new TextEncoder().encode('db'),
      systemFiles: () => [{ name: 'etc/seedypod/hal.toml', path: '/etc/seedypod/hal.toml', optional: false }],
      read: async () => new TextEncoder().encode('unit_id = "bench"'),
      schema: () => ({ migrations: 1, tag: '0000' }),
    },
  })
  const restore = new RestoreClient({ command: helper(), workDir: join(dir, 'work'), uploadDir: dir })
  const core = createCore({ hal, store, events, version: 'test', backup, restore })
  const { app } = createApp({ ctx: core.ctx })
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>(r => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})

afterAll(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const config = { endpoint: 'https://s3.example.com', bucket: 'pods', accessKeyId: 'AK', secretAccessKey: 'SK' }

describe('backup over HTTP', () => {
  it('downloads a named gzip bundle and records it', async () => {
    const r = await fetch(`${base}/api/backup/download`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/gzip')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="seedypod-backup-bench-\d{8}-\d{6}\.tar\.gz"$/)
    const files = untar(new Uint8Array(await r.arrayBuffer()))
    expect([...files.keys()]).toEqual(['seedypod.db', 'etc/seedypod/hal.toml', 'manifest.json'])
    const status = await (await fetch(`${base}/api/backup`)).json() as { available: boolean, lastSuccess: { destination: string } | null, nightly: { enabled: boolean } }
    expect(status).toMatchObject({ available: true, lastSuccess: { destination: 'download' }, nightly: { enabled: false } })
  })

  it('refuses a bucket backup without a mirror, with the reason', async () => {
    const r = await fetch(`${base}/api/backup/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(412)
    expect(((await r.json()) as { message: string }).message).toMatch(/mirror is not configured/)
  })

  it('restores an upload: the helper gets the bytes with --detach, and the answer is 202', async () => {
    answer({ ok: true, detached: true, bundle: { createdAt: '2026-10-31T03:00:00.000Z', unit: { id: 'bench', name: 'Bench' }, core: 'test', schema: 8, photos: false } })
    const r = await fetch(`${base}/api/backup/restore`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: new Uint8Array([0x1F, 0x8B, 9]) })
    expect(r.status).toBe(202)
    expect(await r.json()).toMatchObject({ ok: true, restarting: true, bundle: { unit: { id: 'bench' } } })
    expect([...readFileSync(join(dir, 'seen'))]).toEqual([0x1F, 0x8B, 9])
    expect(readFileSync(join(dir, 'args.log'), 'utf8').trim().split('\n').at(-1)).toMatch(/^--detach .*restore-upload-\d+\.tar\.gz$/)
  })

  it('maps the helper\'s refusals: a newer schema is 409, a bad bundle 400', async () => {
    answer({ ok: false, code: 'newer-schema', error: 'This backup was made by seedypod core main@fff…' }, 3)
    const newer = await fetch(`${base}/api/backup/restore`, { method: 'POST', body: 'x' })
    expect(newer.status).toBe(409)
    expect(await newer.json()).toEqual({ error: 'This backup was made by seedypod core main@fff…', code: 'newer-schema' })
    answer({ ok: false, code: 'invalid', error: 'unexpected file in the bundle: etc/passwd' }, 4)
    expect((await fetch(`${base}/api/backup/restore`, { method: 'POST', body: 'x' })).status).toBe(400)
  })

  it('browses a bucket that isn\'t saved, restores a key from it, and undoes', async () => {
    bucket.set('backups/seedypod-backup-bench-20261031-030000.tar.gz', new Uint8Array([7, 7, 7]))
    const list = await (await fetch(`${base}/api/backup/browse`, json({ config }))).json() as { key: string, unit: string }[]
    expect(list).toMatchObject([{ key: 'backups/seedypod-backup-bench-20261031-030000.tar.gz', unit: 'bench' }])
    answer({ ok: true, detached: true })
    const r = await fetch(`${base}/api/backup/restore-from-bucket`, json({ key: list[0]?.key, config }))
    expect(r.status).toBe(200)
    expect([...readFileSync(join(dir, 'seen'))]).toEqual([7, 7, 7])
    answer({ ok: false, code: 'newer-schema', error: 'newer' }, 3)
    expect((await fetch(`${base}/api/backup/restore-from-bucket`, json({ key: list[0]?.key, config }))).status).toBe(409)
    expect((await fetch(`${base}/api/backup/restore-from-bucket`, json({ key: '../etc/passwd', config }))).status).toBe(412)
    answer({ ok: true, detached: true })
    expect((await fetch(`${base}/api/backup/undo`, json({}))).status).toBe(200)
    expect(readFileSync(join(dir, 'args.log'), 'utf8').trim().split('\n').at(-1)).toBe('--undo --detach')
    answer({ ok: false, code: 'invalid', error: 'there is no restore to undo' }, 4)
    expect((await fetch(`${base}/api/backup/undo`, json({}))).status).toBe(400)
  })

  it('reports what the helper last did and what an undo would put back', async () => {
    const work = join(dir, 'work')
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work)
    writeFileSync(join(work, 'status.json'), JSON.stringify({ op: 'restore', state: 'done', at: '2026-10-31T03:05:00.000Z' }))
    const info = await (await fetch(`${base}/api/backup/restore`)).json()
    expect(info).toEqual({ available: true, status: { op: 'restore', state: 'done', at: '2026-10-31T03:05:00.000Z' }, undo: null })
  })
})

describe('restore where the helper is not installed', () => {
  it('says so instead of failing', async () => {
    const hal = new SimHal({ tickMs: 0 })
    const core = createCore({ hal, store: new MemoryStore(), version: 'test', restore: new RestoreClient({ command: null, workDir: '/nonexistent', uploadDir: '/nonexistent' }) })
    const { app } = createApp({ ctx: core.ctx })
    const r = await app.request('/api/backup/restore', { method: 'POST', body: 'x' })
    expect(r.status).toBe(412)
    expect(((await r.json()) as { code: string }).code).toBe('unavailable')
    const caller = await app.request('/api/backup/restore')
    expect(await caller.json()).toEqual({ available: false, status: null, undo: null })
    await hal.close()
  })
})
