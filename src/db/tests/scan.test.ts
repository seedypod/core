import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultMigrationsFolder, SqliteStore } from '../../store/sqlite'
import { checkIntegrity, runJob, scanDatabase, STOP_AFTER_OLD_ROWS, yieldToEventLoop } from '../scan'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-06T12:30:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let dir: string
let path: string
let store: SqliteStore
let db: Database.Database

const scan = (migrationsFolder = defaultMigrationsFolder()) => scanDatabase({ kind: 'scan', path, migrationsFolder, now: NOW })
const table = (name: string) => {
  const t = scan().tables.find(x => x.name === name)
  if (!t) throw new Error(`no table ${name}`)
  return t
}
const journal = (entries: Array<{ tag: string, when: number }>) => {
  const folder = join(dir, 'migrations')
  mkdirSync(join(folder, 'meta'), { recursive: true })
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ entries }))
  return folder
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seedypod-scan-'))
  path = join(dir, 'seedypod.db')
  store = new SqliteStore({ url: path })
  db = new Database(path)
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('scanDatabase', () => {
  it('reports the file, the WAL and the journal mode', () => {
    db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)').run(ago(0), 'ph', 6)
    const r = scan()
    expect(r).toMatchObject({ at: new Date(NOW).toISOString(), path, journalMode: 'wal', pageSize: 4096 })
    expect(r.fileBytes).toBeGreaterThan(0)
    expect(r.walBytes).toBeGreaterThan(0)
    expect(r.freePages).toBeGreaterThanOrEqual(0)
    expect(r.scanMs).toBeGreaterThanOrEqual(0)
  })

  it('counts a missing WAL as empty', () => {
    db.close()
    store.close()
    expect(scan().walBytes).toBe(0)
  })

  it('lists every table but the migration log, with rows, bytes and indexes counted', () => {
    const add = db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)')
    for (let i = 0; i < 2000; i++) add.run(ago(i * 60_000), 'ph', i)
    const r = scan()
    expect(r.tables.map(t => t.name)).toContain('telemetry')
    expect(r.tables.map(t => t.name)).not.toContain('__drizzle_migrations')
    expect(r.tables.some(t => t.name.startsWith('sqlite_'))).toBe(false)
    const t = r.tables.find(x => x.name === 'telemetry')
    expect(t?.rows).toBe(2000)
    // Leaf and index pages both count, so it is more than the table's own b-tree.
    const own = (db.prepare(`SELECT SUM(pgsize) AS b FROM dbstat WHERE name = 'telemetry'`).get() as { b: number }).b
    expect(t?.bytes).toBeGreaterThan(own)
    for (const x of r.tables) expect(x.rows).toBe((db.prepare(`SELECT COUNT(*) AS n FROM "${x.name}"`).get() as { n: number }).n)
  })

  it('buckets rows into the last 24 clock hours, oldest first', () => {
    const add = db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)')
    add.run(ago(25 * HOUR), 'ph', 1)
    add.run(ago(23 * HOUR), 'ph', 1)
    add.run(ago(HOUR), 'ph', 1)
    add.run(ago(0), 'ph', 1)
    add.run(ago(60_000), 'ph', 1)
    const t = table('telemetry')
    expect(t).toMatchObject({ timeColumn: 'ts', basis: 'inserted', lastWriteAt: ago(0), writes24h: 4 })
    expect(t.hourly).toHaveLength(24)
    expect(t.hourly?.[0]).toBe(1)
    expect(t.hourly?.[22]).toBe(1)
    expect(t.hourly?.[23]).toBe(2)
  })

  it('reads hald timestamps, which have no milliseconds', () => {
    db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)').run('2026-11-06T12:05:00Z', 'ph', 1)
    expect(table('telemetry').hourly?.[23]).toBe(1)
  })

  it('ignores a row dated ahead of now, but still reports it as the last write', () => {
    db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)').run(ago(-5 * HOUR), 'ph', 1)
    expect(table('telemetry')).toMatchObject({ writes24h: 0, lastWriteAt: ago(-5 * HOUR) })
  })

  it('says updatedAt tables count rows changed, and finds an old row touched recently', () => {
    const t = table('pods')
    expect(t).toMatchObject({ timeColumn: 'updatedAt', basis: 'changed' })
    db.prepare('UPDATE pods SET updatedAt = ?').run(ago(26 * HOUR))
    db.prepare('UPDATE pods SET updatedAt = ? WHERE slot = 1').run(ago(HOUR))
    expect(table('pods')).toMatchObject({ writes24h: 1, lastWriteAt: ago(HOUR) })
  })

  it('stops walking back once rows have been older than the window for long enough', () => {
    const add = db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)')
    add.run(ago(HOUR), 'ph', 1)
    for (let i = 0; i < STOP_AFTER_OLD_ROWS; i++) add.run(ago(48 * HOUR), 'ph', 1)
    add.run(ago(0), 'ph', 1)
    expect(table('telemetry').writes24h).toBe(1)
  })

  it('keeps walking past a run of old rows shorter than the limit, such as a re-analysis', () => {
    const add = db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)')
    add.run(ago(HOUR), 'ph', 1)
    for (let i = 0; i < STOP_AFTER_OLD_ROWS - 1; i++) add.run(ago(48 * HOUR), 'ph', 1)
    add.run(ago(0), 'ph', 1)
    expect(table('telemetry').writes24h).toBe(2)
  })

  it('has no hourly writes, not zero, for a table with no time column', () => {
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
    db.prepare('INSERT INTO notes (body) VALUES (?)').run('x')
    expect(table('notes')).toMatchObject({ rows: 1, timeColumn: null, basis: null, lastWriteAt: null, hourly: null, writes24h: null })
  })

  it('falls back to COUNT(*) and no sizes when SQLite was built without dbstat', () => {
    const real = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes('dbstat')) throw new Error('no such table: dbstat')
      return real.call(this, sql)
    } as typeof real)
    db.prepare('INSERT INTO counters (key, value, updatedAt) VALUES (?, ?, ?)').run('k', 1, ago(0))
    const t = table('counters')
    expect(t).toMatchObject({ rows: 1, bytes: null })
  })

  it('never carries a row\'s contents', () => {
    store.settings.update({ mirrorSecretAccessKey: 'bucket-secret', mqttPassword: 'mqtt-secret', apiKey: 'api-secret' })
    const text = JSON.stringify(scan())
    for (const secret of ['bucket-secret', 'mqtt-secret', 'api-secret']) expect(text).not.toContain(secret)
  })

  it('leaves the database and WAL as they were, with core writing beside it', () => {
    db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)').run(ago(0), 'ph', 1)
    const before = [readFileSync(path), readFileSync(`${path}-wal`)]
    scan()
    checkIntegrity({ kind: 'integrity', path, now: NOW })
    expect(readFileSync(path).equals(before[0] as Buffer)).toBe(true)
    expect(readFileSync(`${path}-wal`).equals(before[1] as Buffer)).toBe(true)
  })

  it('names the applied migration from the shipped journal', () => {
    const entries = (JSON.parse(readFileSync(join(defaultMigrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> }).entries
    const last = entries.at(-1)?.tag
    expect(scan().migrations).toEqual({ applied: entries.length, known: entries.length, latestTag: last, appliedTag: last })
  })

  it('reports migrations this build doesn\'t know, and a journal with none', () => {
    expect(scan(journal([{ tag: '0000_old', when: 1 }])).migrations).toMatchObject({ known: 1, latestTag: '0000_old', appliedTag: null })
    expect(scan(journal([])).migrations).toMatchObject({ known: 0, latestTag: null, appliedTag: null })
  })

  it('throws for a database that isn\'t there', () => {
    expect(() => scanDatabase({ kind: 'scan', path: join(dir, 'nope.db'), migrationsFolder: defaultMigrationsFolder(), now: NOW })).toThrow()
  })
})

describe('checkIntegrity', () => {
  it('passes a healthy database', () => {
    expect(checkIntegrity({ kind: 'integrity', path, now: NOW })).toMatchObject({ ok: true, detail: 'ok', checkedAt: new Date(NOW).toISOString() })
  })

  it('reports the first problem in a damaged one', () => {
    const add = db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)')
    for (let i = 0; i < 3000; i++) add.run(ago(i), 'ph', i)
    db.pragma('wal_checkpoint(TRUNCATE)')
    const bad = join(dir, 'bad.db')
    copyFileSync(path, bad)
    const file = readFileSync(bad)
    const page = file.readUInt16BE(16)
    const root = (db.prepare(`SELECT rootpage FROM sqlite_schema WHERE name = 'telemetry'`).get() as { rootpage: number }).rootpage
    // A root page whose cell pointers run off the page.
    file.fill(0xff, (root - 1) * page + 8, root * page)
    writeFileSync(bad, file)
    const run = checkIntegrity({ kind: 'integrity', path: bad, now: NOW })
    expect(run.ok).toBe(false)
    expect(run.detail).not.toBe('ok')
  })
})

describe('runJob', () => {
  it('dispatches on the kind of job', () => {
    expect(runJob({ kind: 'integrity', path, now: NOW })).toMatchObject({ ok: true })
    expect(runJob({ kind: 'scan', path, migrationsFolder: defaultMigrationsFolder(), now: NOW })).toHaveProperty('tables')
  })
})

describe('yieldToEventLoop', () => {
  it('nices the thread on Linux, where the value is per thread', () => {
    const set = vi.fn()
    yieldToEventLoop('linux', set)
    expect(set).toHaveBeenCalledWith(0, 19)
  })

  it('leaves other platforms alone, where it would slow the whole process', () => {
    const set = vi.fn()
    yieldToEventLoop('darwin', set)
    expect(set).not.toHaveBeenCalled()
  })
})
