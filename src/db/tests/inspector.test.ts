import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultMigrationsFolder, SqliteStore } from '../../store/sqlite'
import { NodeDatabaseInspector, runInWorker } from '../inspector'
import * as scan from '../scan'

// Runs the real worker entry through tsx, the way `node server/dist/inspectWorker.js` runs it on a unit.
const script = new URL('../inspectWorker.ts', import.meta.url)
const execArgv = { execArgv: ['--import', 'tsx'] }
const MIN = 60_000

let dir: string
let path: string
let store: SqliteStore
let clock: number

const inspector = (o: Partial<ConstructorParameters<typeof NodeDatabaseInspector>[0]> = {}) =>
  new NodeDatabaseInspector({ path, migrationsFolder: defaultMigrationsFolder(), worker: null, now: () => new Date(clock), ...o })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seedypod-inspector-'))
  path = join(dir, 'seedypod.db')
  store = new SqliteStore({ url: path })
  clock = Date.parse('2026-11-06T12:00:00Z')
})
afterEach(() => {
  vi.restoreAllMocks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('NodeDatabaseInspector', () => {
  it('serves the cache until it is five minutes old', async () => {
    const run = vi.spyOn(scan, 'runJob')
    const i = inspector()
    const first = await i.inspect()
    clock += 4 * MIN
    expect((await i.inspect()).at).toBe(first.at)
    expect(run).toHaveBeenCalledTimes(1)
    clock += 2 * MIN
    expect((await i.inspect()).at).not.toBe(first.at)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('caches a slow scan for longer, so a large file never takes more than 1/20th of the time', async () => {
    const real = scan.runJob
    vi.spyOn(scan, 'runJob').mockImplementation(job => ({ ...real(job), scanMs: 60_000 }))
    const i = inspector()
    const first = await i.inspect()
    clock += 19 * MIN
    expect((await i.inspect()).at).toBe(first.at)
    clock += 2 * MIN
    expect((await i.inspect()).at).not.toBe(first.at)
  })

  it('shares one scan between concurrent callers', async () => {
    const run = vi.spyOn(scan, 'runJob')
    const i = inspector()
    const [a, b] = await Promise.all([i.inspect(), i.inspect()])
    expect(a.at).toBe(b.at)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs one job at a time', async () => {
    let running = 0
    let most = 0
    const real = scan.runJob
    vi.spyOn(scan, 'runJob').mockImplementation(((job: scan.InspectJob) => {
      most = Math.max(most, ++running)
      return new Promise((resolve) => {
        setTimeout(() => {
          running--
          resolve(real(job))
        }, 5)
      })
    }) as unknown as typeof real)
    const i = inspector()
    await Promise.all([i.inspect(), i.checkIntegrity()])
    expect(most).toBe(1)
  })

  it('shows the last integrity check in later reports, including cached ones', async () => {
    const i = inspector()
    expect((await i.inspect()).integrity).toBeNull()
    const run = await i.checkIntegrity()
    expect(run).toMatchObject({ ok: true, detail: 'ok' })
    expect((await i.inspect()).integrity).toEqual(run)
  })

  it('shares one integrity check between concurrent callers', async () => {
    const run = vi.spyOn(scan, 'runJob')
    const i = inspector()
    await Promise.all([i.checkIntegrity(), i.checkIntegrity()])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps working after a failed scan', async () => {
    const i = inspector({ path: join(dir, 'gone.db') })
    await expect(i.inspect()).rejects.toThrow()
    await expect(i.checkIntegrity()).rejects.toThrow()
    const ok = inspector()
    await expect(ok.inspect()).resolves.toHaveProperty('tables')
  })

  it('uses the wall clock unless told otherwise', async () => {
    const i = new NodeDatabaseInspector({ path, migrationsFolder: defaultMigrationsFolder(), worker: null })
    expect(Date.parse((await i.inspect()).at)).toBeGreaterThan(clock - 365 * 24 * 60 * MIN)
  })

  it('scans on a worker thread and leaves the database to core', async () => {
    const i = inspector({ worker: script, workerOptions: execArgv })
    const r = await i.inspect()
    expect(r.tables.map(t => t.name)).toContain('telemetry')
    expect(await i.checkIntegrity()).toMatchObject({ ok: true })
  }, 20_000)
})

describe('runInWorker', () => {
  const job = () => ({ kind: 'integrity' as const, path, now: clock })

  it('rejects with the scan\'s own error', async () => {
    await expect(runInWorker(script, { ...job(), path: join(dir, 'nope.db') }, 15_000, execArgv)).rejects.toThrow(/unable to open/)
  }, 20_000)

  it('rejects when the worker cannot start', async () => {
    await expect(runInWorker(new URL('./does-not-exist.js', import.meta.url), job(), 15_000)).rejects.toThrow()
  }, 20_000)

  it('rejects when the worker exits without an answer', async () => {
    await expect(runInWorker(new URL('data:text/javascript,process.exit(3)'), job(), 15_000)).rejects.toThrow('exited with code 3')
  }, 20_000)

  it('gives up on a scan that takes too long', async () => {
    await expect(runInWorker(new URL('data:text/javascript,setInterval(()=>{},1000)'), job(), 50)).rejects.toThrow('timed out')
  }, 20_000)
})

describe('a scan beside a live writer', () => {
  it('doesn\'t block core\'s writes', async () => {
    const add = new Database(path)
    const insert = add.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)')
    const pending = inspector({ worker: script, workerOptions: execArgv }).inspect()
    for (let i = 0; i < 100; i++) insert.run(new Date(clock).toISOString(), 'ph', i)
    await expect(pending).resolves.toHaveProperty('tables')
    add.close()
  }, 20_000)
})
