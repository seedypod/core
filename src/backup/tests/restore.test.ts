import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RestoreClient, RestoreRefused, restoreCommand } from '../restore'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'restore-client-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in helper: records its arguments and the bundle it was handed, then answers as told. */
function fakeHelper(answer: object, exit = 0) {
  const script = join(dir, 'helper.mjs')
  writeFileSync(script, `import { appendFileSync, copyFileSync, existsSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'args.log'))}, args.join(' ') + '\\n')
const bundle = args.find(a => a.endsWith('.tar.gz'))
if (bundle && existsSync(bundle)) copyFileSync(bundle, ${JSON.stringify(join(dir, 'seen.tar.gz'))})
console.log('some progress')
console.log(${JSON.stringify(JSON.stringify(answer))})
process.exit(${exit})
`)
  return new RestoreClient({ command: [process.execPath, script], workDir: join(dir, 'work'), uploadDir: dir })
}

describe('RestoreClient', () => {
  it('hands the bundle to the helper with --detach and removes the upload afterwards', async () => {
    const c = fakeHelper({ ok: true, detached: true, bundle: { createdAt: '2026-10-31T03:00:00.000Z', unit: { id: 'kitchen', name: 'Kitchen' }, core: 'main@abc', schema: 7, photos: false } })
    const summary = await c.restore(new Uint8Array([1, 2, 3]))
    expect(summary).toMatchObject({ unit: { id: 'kitchen' }, schema: 7 })
    expect(readFileSync(join(dir, 'args.log'), 'utf8')).toMatch(/^--detach .*restore-upload-\d+\.tar\.gz\n$/)
    expect([...readFileSync(join(dir, 'seen.tar.gz'))]).toEqual([1, 2, 3])
    expect(readdirSync(dir).filter(f => f.startsWith('restore-upload-'))).toEqual([])
  })

  it('streams an upload to disk through the writer it is given', async () => {
    const c = fakeHelper({ ok: true })
    await c.restore(async path => writeFileSync(path, 'streamed'))
    expect(readFileSync(join(dir, 'seen.tar.gz'), 'utf8')).toBe('streamed')
  })

  it('passes on a refusal with its code and message', async () => {
    const c = fakeHelper({ ok: false, code: 'newer-schema', error: 'This backup was made by seedypod core main@fff (database schema 9)…' }, 3)
    const err = await c.restore(new Uint8Array()).catch(e => e as RestoreRefused)
    expect(err).toBeInstanceOf(RestoreRefused)
    expect(err).toMatchObject({ code: 'newer-schema', message: expect.stringMatching(/^This backup was made by/) })
    expect(readdirSync(dir).filter(f => f.startsWith('restore-upload-'))).toEqual([])
  })

  it('reports a helper that gives no answer as a failure with its stderr', async () => {
    const script = join(dir, 'broken.mjs')
    writeFileSync(script, 'console.error("sudo: a password is required"); process.exit(1)')
    const c = new RestoreClient({ command: [process.execPath, script], workDir: dir, uploadDir: dir })
    await expect(c.undo()).rejects.toMatchObject({ code: 'failed', message: 'sudo: a password is required' })
  })

  it('undo runs --undo --detach', async () => {
    const c = fakeHelper({ ok: true, detached: true })
    await c.undo()
    expect(readFileSync(join(dir, 'args.log'), 'utf8')).toBe('--undo --detach\n')
  })

  it('says restore is not installed when there is no helper', async () => {
    const c = new RestoreClient({ command: null, workDir: dir, uploadDir: dir })
    expect(c.available).toBe(false)
    await expect(c.restore(new Uint8Array())).rejects.toMatchObject({ code: 'unavailable' })
    expect(c.info()).toEqual({ available: false, status: null, undo: null })
  })

  it('reads the helper\'s status and undo files, without the per-file list', () => {
    const c = fakeHelper({ ok: true })
    const work = join(dir, 'work')
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work)
    writeFileSync(join(work, 'status.json'), JSON.stringify({ op: 'restore', state: 'done', at: '2026-10-31T03:05:00.000Z' }))
    writeFileSync(join(work, 'undo.json'), JSON.stringify({ restoredAt: '2026-10-31T03:05:00.000Z', bundle: { createdAt: '2026-10-30T03:00:00.000Z' }, items: [{ rel: 'data/seedypod.db' }], undoneAt: null }))
    expect(c.info()).toEqual({
      available: true,
      status: { op: 'restore', state: 'done', at: '2026-10-31T03:05:00.000Z' },
      undo: { restoredAt: '2026-10-31T03:05:00.000Z', bundle: { createdAt: '2026-10-30T03:00:00.000Z' }, undoneAt: null },
    })
  })
})

describe('restoreCommand', () => {
  it('takes SEEDYPOD_RESTORE_CMD as a JSON array', () => {
    expect(restoreCommand({ SEEDYPOD_RESTORE_CMD: '["node","scripts/seedypod-restore.cjs"]' })).toEqual(['node', 'scripts/seedypod-restore.cjs'])
  })
  it('falls back to sudo and the installed helper only when it exists', () => {
    const cmd = restoreCommand({})
    expect(cmd === null || (cmd[0] === 'sudo' && cmd[2] === '/usr/local/sbin/seedypod-restore')).toBe(true)
    expect(existsSync('/usr/local/sbin/seedypod-restore') ? cmd : null).toEqual(cmd)
  })
})
