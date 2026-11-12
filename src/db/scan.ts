/**
 * The scan behind the Database view. Node-only: `inspector.ts` runs it on a
 * worker thread. It opens its own read-only connection and keeps each
 * statement in its own read transaction, because a transaction held across
 * the scan would stop checkpoints from resetting the WAL and make the file
 * grow on the card it is measuring.
 */
import Database from 'better-sqlite3'
import { readFileSync, statSync } from 'node:fs'
import { setPriority } from 'node:os'
import { join } from 'node:path'
import type { DatabaseReport, IntegrityRun, MigrationReport, TableReport, WriteBasis } from './inspect'

const HOUR = 3_600_000
const MIGRATIONS_TABLE = '__drizzle_migrations'

/** Columns that date a row, most specific first. All are ISO text in UTC, so the first 13 characters name the hour. */
export const TIME_COLUMNS: ReadonlyArray<readonly [string, WriteBasis]> = [
  ['ts', 'inserted'],
  ['firedAt', 'inserted'],
  ['updatedAt', 'changed'],
  ['raisedAt', 'inserted'],
  ['createdAt', 'inserted'],
  ['startedAt', 'inserted'],
]

/**
 * The hourly walk starts at the newest row and stops after this many rows in
 * a row older than the window. Telemetry has no index on time alone, so this
 * reads a day of rows instead of the whole table. Small tables, where an
 * update can date an old rowid recently, are read in full.
 */
export const STOP_AFTER_OLD_ROWS = 1000

export interface ScanJob {
  kind: 'scan'
  path: string
  migrationsFolder: string
  now: number
}

export interface IntegrityJob {
  kind: 'integrity'
  path: string
  now: number
}

export type InspectJob = ScanJob | IntegrityJob

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

function open(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 2000')
  // better-sqlite3 builds with TEMP_STORE=1: without this a sort that spills goes to a file on the card.
  db.pragma('temp_store = MEMORY')
  // A scan reads each page once, so the 16 MB default cache would only cost RAM.
  db.pragma('cache_size = -2048')
  return db
}

/**
 * Bytes per table with its indexes, and exact row counts from the leaf cells,
 * in the one pass over the file. Null when SQLite was built without dbstat.
 */
function tableSizes(db: Database.Database): Map<string, { bytes: number, rows: number }> | null {
  const owners = new Map((db.prepare('SELECT name, tbl_name AS owner FROM sqlite_schema').all() as Array<{ name: string, owner: string }>).map(r => [r.name, r.owner]))
  let pages: Array<{ name: string, bytes: number, cells: number }>
  try {
    pages = db.prepare(`SELECT name, SUM(pgsize) AS bytes, SUM(CASE WHEN pagetype = 'leaf' THEN ncell ELSE 0 END) AS cells FROM dbstat GROUP BY name`).all() as typeof pages
  }
  catch {
    return null
  }
  const sizes = new Map<string, { bytes: number, rows: number }>()
  for (const p of pages) {
    const owner = owners.get(p.name) ?? p.name
    const size = sizes.get(owner) ?? { bytes: 0, rows: 0 }
    size.bytes += p.bytes
    if (owner === p.name) size.rows = p.cells
    sizes.set(owner, size)
  }
  return sizes
}

function writes(db: Database.Database, table: string, column: string, now: number): Pick<TableReport, 'lastWriteAt' | 'hourly' | 'writes24h'> {
  const firstHour = Math.floor(now / HOUR) * HOUR - 23 * HOUR
  const from = new Date(firstHour).toISOString()
  const hourOf = new Map(Array.from({ length: 24 }, (_, i) => [new Date(firstHour + i * HOUR).toISOString().slice(0, 13), i]))
  const hourly = new Array<number>(24).fill(0)
  let last: string | null = null
  let old = 0
  for (const { ts } of db.prepare(`SELECT ${quote(column)} AS ts FROM ${quote(table)} ORDER BY rowid DESC`).iterate() as Iterable<{ ts: string }>) {
    if (last === null || ts > last) last = ts
    if (ts < from) {
      if (++old >= STOP_AFTER_OLD_ROWS) break
      continue
    }
    old = 0
    // Undefined for a row dated ahead of now, which a wrong clock can do.
    const hour = hourOf.get(ts.slice(0, 13))
    if (hour !== undefined) hourly[hour] = (hourly[hour] as number) + 1
  }
  return { lastWriteAt: last, hourly, writes24h: hourly.reduce((a, b) => a + b, 0) }
}

function tables(db: Database.Database, now: number): TableReport[] {
  const names = (db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ? ORDER BY name`).all(MIGRATIONS_TABLE) as Array<{ name: string }>).map(r => r.name)
  const sizes = tableSizes(db)
  return names.map((name) => {
    const columns = new Set((db.pragma(`table_info(${quote(name)})`) as Array<{ name: string }>).map(c => c.name))
    const time = TIME_COLUMNS.find(([c]) => columns.has(c))
    const size = sizes?.get(name)
    const rows = size?.rows ?? (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as { n: number }).n
    return {
      name,
      rows,
      bytes: size?.bytes ?? null,
      timeColumn: time?.[0] ?? null,
      basis: time?.[1] ?? null,
      ...(time ? writes(db, name, time[0], now) : { lastWriteAt: null, hourly: null, writes24h: null }),
    }
  })
}

function migrations(db: Database.Database, folder: string): MigrationReport {
  const applied = db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM ${quote(MIGRATIONS_TABLE)}`).get() as { n: number, last: number | null }
  const { entries } = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string, when: number }> }
  return {
    applied: applied.n,
    known: entries.length,
    latestTag: entries.at(-1)?.tag ?? null,
    appliedTag: entries.find(e => e.when === applied.last)?.tag ?? null,
  }
}

function fileBytes(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0
}

export function scanDatabase(job: ScanJob): Omit<DatabaseReport, 'integrity'> {
  const started = performance.now()
  const files = { fileBytes: fileBytes(job.path), walBytes: fileBytes(`${job.path}-wal`) }
  const db = open(job.path)
  try {
    const report = {
      at: new Date(job.now).toISOString(),
      path: job.path,
      ...files,
      journalMode: db.pragma('journal_mode', { simple: true }) as string,
      pageSize: db.pragma('page_size', { simple: true }) as number,
      freePages: db.pragma('freelist_count', { simple: true }) as number,
      migrations: migrations(db, job.migrationsFolder),
      tables: tables(db, job.now),
    }
    return { ...report, scanMs: Math.round(performance.now() - started) }
  }
  finally {
    db.close()
  }
}

/** `quick_check`, not `integrity_check`: it skips matching indexes to tables, which on a Pi Zero W is most of the wait. */
export function checkIntegrity(job: IntegrityJob): IntegrityRun {
  const started = performance.now()
  const db = open(job.path)
  try {
    const detail = String(db.pragma('quick_check(1)', { simple: true }))
    return { ok: detail === 'ok', detail, checkedAt: new Date(job.now).toISOString(), ms: Math.round(performance.now() - started) }
  }
  finally {
    db.close()
  }
}

export function runJob(job: InspectJob): Omit<DatabaseReport, 'integrity'> | IntegrityRun {
  return job.kind === 'scan' ? scanDatabase(job) : checkIntegrity(job)
}

/**
 * A worker gets no CPU of its own on a Pi Zero W's single core, so nice it to
 * let the event loop and hald pre-empt it. On Linux the nice value is per
 * thread; elsewhere this call would slow the whole server.
 */
export function yieldToEventLoop(platform: NodeJS.Platform = process.platform, set: typeof setPriority = setPriority): void {
  if (platform === 'linux') set(0, 19)
}
