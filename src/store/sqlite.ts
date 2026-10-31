import Database from 'better-sqlite3'
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SensorId } from '../hardware/contract'
import * as t from '../db/schema'
import { downsample } from './memory'
import type { AlertRow, Capture, DeviceSettings, GrowCycle, GrowStage, LightSpec, Pod, PumpSpec, Schedule, ScheduleRun, Store, TelemetryPoint } from './types'
import { DEFAULT_SETTINGS } from './types'

export interface SqliteStoreOptions {
  /** File path or ':memory:'. */
  url: string
  podCount?: number
  /** Override for tests; defaults to src/db/migrations next to the schema. */
  migrationsFolder?: string
}

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Migrations live in src/db/migrations. From source (vitest/tsx) that is next
 * to this file; from the esbuild bundle (server/dist/index.js) it is two levels
 * up; MIGRATIONS_DIR overrides both for exotic layouts.
 */
export function defaultMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    join(here, '../db/migrations'),
    resolve(here, '../../src/db/migrations'),
    resolve(process.cwd(), 'src/db/migrations'),
  ].filter((c): c is string => !!c)
  return candidates.find(c => existsSync(join(c, 'meta/_journal.json'))) ?? candidates[1] as string
}

export class SqliteStore implements Store {
  private readonly sqlite: Database.Database
  private readonly db

  constructor(opts: SqliteStoreOptions) {
    this.sqlite = new Database(opts.url)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('busy_timeout = 5000')
    this.db = drizzle(this.sqlite, { schema: t })
    migrate(this.db, { migrationsFolder: opts.migrationsFolder ?? defaultMigrationsFolder() })
    this.seed(opts.podCount ?? 30)
  }

  private seed(podCount: number) {
    const now = new Date().toISOString()
    this.db.insert(t.deviceSettings).values({ id: 1, ...DEFAULT_SETTINGS, updatedAt: now }).onConflictDoNothing().run()
    for (let slot = 1; slot <= podCount; slot++) {
      this.db.insert(t.pods).values({ slot, status: 'empty', notes: '', updatedAt: now }).onConflictDoNothing().run()
    }
  }

  settings = {
    get: (): DeviceSettings => {
      const row = this.db.select().from(t.deviceSettings).where(eq(t.deviceSettings.id, 1)).get()
      if (!row) throw new Error('device_settings row missing')
      const rest: DeviceSettings & { id?: number } = { ...row }
      delete rest.id
      return rest
    },
    update: (patch: Partial<Omit<DeviceSettings, 'updatedAt'>>): DeviceSettings => {
      this.db.update(t.deviceSettings).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(t.deviceSettings.id, 1)).run()
      return this.settings.get()
    },
  }

  schedules = {
    list: (): Schedule[] => this.db.select().from(t.schedules).orderBy(asc(t.schedules.name)).all().map(rowToSchedule),
    get: (id: string): Schedule | null => {
      const r = this.db.select().from(t.schedules).where(eq(t.schedules.id, id)).get()
      return r ? rowToSchedule(r) : null
    },
    upsert: (s: Omit<Schedule, 'createdAt' | 'updatedAt'> & Partial<Pick<Schedule, 'createdAt'>>): Schedule => {
      const now = new Date().toISOString()
      const values = { id: s.id, kind: s.kind, name: s.name, enabled: s.enabled, days: s.days, spec: JSON.stringify(s.spec), createdAt: s.createdAt ?? now, updatedAt: now }
      this.db.insert(t.schedules).values(values).onConflictDoUpdate({ target: t.schedules.id, set: { kind: values.kind, name: values.name, enabled: values.enabled, days: values.days, spec: values.spec, updatedAt: now } }).run()
      return this.schedules.get(s.id) as Schedule
    },
    remove: (id: string): boolean => this.db.delete(t.schedules).where(eq(t.schedules.id, id)).run().changes > 0,
    recordRun: (run: ScheduleRun): boolean => {
      const r = this.db.insert(t.scheduleRuns).values(run).onConflictDoNothing().run()
      return r.changes > 0
    },
    recentRuns: (limit = 50): ScheduleRun[] =>
      this.db.select({ scheduleId: t.scheduleRuns.scheduleId, key: t.scheduleRuns.key, firedAt: t.scheduleRuns.firedAt, result: t.scheduleRuns.result })
        .from(t.scheduleRuns).orderBy(desc(t.scheduleRuns.id)).limit(limit).all(),
  }

  alerts = {
    list: (opts?: { activeOnly?: boolean }): AlertRow[] => {
      const q = this.db.select().from(t.alerts)
      const rows = opts?.activeOnly ? q.where(eq(t.alerts.active, true)).all() : q.all()
      return rows.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
    },
    raise: (kind: string, detail: string, ts: string): AlertRow => {
      const existing = this.db.select().from(t.alerts).where(and(eq(t.alerts.kind, kind), eq(t.alerts.active, true))).get()
      if (existing) {
        this.db.update(t.alerts).set({ detail }).where(eq(t.alerts.id, existing.id)).run()
        return { ...existing, detail }
      }
      const r = this.db.insert(t.alerts).values({ kind, active: true, detail, raisedAt: ts }).returning().get()
      return r
    },
    clear: (kind: string, ts: string): AlertRow | null => {
      const existing = this.db.select().from(t.alerts).where(and(eq(t.alerts.kind, kind), eq(t.alerts.active, true))).get()
      if (!existing) return null
      return this.db.update(t.alerts).set({ active: false, clearedAt: ts }).where(eq(t.alerts.id, existing.id)).returning().get() ?? null
    },
    acknowledge: (id: number, ts: string): AlertRow | null =>
      this.db.update(t.alerts).set({ acknowledgedAt: ts }).where(eq(t.alerts.id, id)).returning().get() ?? null,
    dismiss: (id: number, ts: string): AlertRow | null =>
      this.db.update(t.alerts).set({ dismissedAt: ts, active: false }).where(eq(t.alerts.id, id)).returning().get() ?? null,
  }

  grow = {
    current: (): GrowCycle | null => {
      const r = this.db.select().from(t.growCycles).where(sql`${t.growCycles.endedAt} IS NULL`).get()
      return r ? rowToCycle(r) : null
    },
    start: (ts: string, notes = ''): GrowCycle => {
      this.db.update(t.growCycles).set({ endedAt: ts, stage: 'ended' }).where(sql`${t.growCycles.endedAt} IS NULL`).run()
      const count = this.db.select({ n: sql<number>`count(*)` }).from(t.growCycles).get()?.n ?? 0
      const row = this.db.insert(t.growCycles).values({ id: `cycle-${count + 1}`, startedAt: ts, stage: 'germination', notes, issued: '[]' }).returning().get()
      return rowToCycle(row)
    },
    setStage: (stage: GrowStage): GrowCycle | null => {
      const r = this.db.update(t.growCycles).set({ stage }).where(sql`${t.growCycles.endedAt} IS NULL`).returning().get()
      return r ? rowToCycle(r) : null
    },
    markIssued: (reminder: string): void => {
      const c = this.grow.current()
      if (!c || c.issued.includes(reminder)) return
      this.db.update(t.growCycles).set({ issued: JSON.stringify([...c.issued, reminder]) }).where(eq(t.growCycles.id, c.id)).run()
    },
    end: (ts: string): GrowCycle | null => {
      const r = this.db.update(t.growCycles).set({ endedAt: ts, stage: 'ended' }).where(sql`${t.growCycles.endedAt} IS NULL`).returning().get()
      return r ? rowToCycle(r) : null
    },
    history: (): GrowCycle[] => this.db.select().from(t.growCycles).orderBy(desc(t.growCycles.startedAt)).all().map(rowToCycle),
  }

  pods = {
    list: (): Pod[] => this.db.select().from(t.pods).orderBy(asc(t.pods.slot)).all(),
    update: (slot: number, patch: Partial<Omit<Pod, 'slot' | 'updatedAt'>>, ts: string): Pod => {
      const r = this.db.update(t.pods).set({ ...patch, updatedAt: ts }).where(eq(t.pods.slot, slot)).returning().get()
      if (!r) throw new Error(`no pod ${slot}`)
      return r
    },
  }

  captures = {
    add: (c: Capture): void => {
      this.db.insert(t.captures).values(c).run()
    },
    list: (camera?: 'upper' | 'lower', limit = 100): Capture[] => {
      const q = this.db.select().from(t.captures)
      const rows = camera ? q.where(eq(t.captures.camera, camera)).orderBy(desc(t.captures.ts)).limit(limit).all() : q.orderBy(desc(t.captures.ts)).limit(limit).all()
      return rows
    },
    get: (id: string): Capture | null => this.db.select().from(t.captures).where(eq(t.captures.id, id)).get() ?? null,
    prune: (camera: 'upper' | 'lower', keep: number): Capture[] => {
      const rows = this.db.select().from(t.captures).where(eq(t.captures.camera, camera)).orderBy(desc(t.captures.ts)).all()
      const drop = rows.slice(keep)
      for (const d of drop) this.db.delete(t.captures).where(eq(t.captures.id, d.id)).run()
      return drop
    },
  }

  telemetry = {
    add: (pts: TelemetryPoint[]): void => {
      if (pts.length === 0) return
      this.db.insert(t.telemetry).values(pts).run()
    },
    range: (sensor: SensorId, fromTs: string, toTs: string, maxPoints = 500): TelemetryPoint[] => {
      const rows = this.db.select({ ts: t.telemetry.ts, sensor: t.telemetry.sensor, value: t.telemetry.value }).from(t.telemetry)
        .where(and(eq(t.telemetry.sensor, sensor), gte(t.telemetry.ts, fromTs), lte(t.telemetry.ts, toTs))).orderBy(asc(t.telemetry.ts)).all()
      return downsample(rows as TelemetryPoint[], maxPoints)
    },
  }

  counters = {
    add: (key: string, delta: number, ts: string): number => {
      this.db.insert(t.counters).values({ key, value: delta, updatedAt: ts })
        .onConflictDoUpdate({ target: t.counters.key, set: { value: sql`${t.counters.value} + ${delta}`, updatedAt: ts } }).run()
      return this.counters.get(key)
    },
    get: (key: string): number => this.db.select().from(t.counters).where(eq(t.counters.key, key)).get()?.value ?? 0,
  }

  close(): void {
    this.sqlite.close()
  }
}

function rowToSchedule(r: typeof t.schedules.$inferSelect): Schedule {
  return { ...r, spec: JSON.parse(r.spec) as LightSpec | PumpSpec }
}

function rowToCycle(r: typeof t.growCycles.$inferSelect): GrowCycle {
  return { ...r, issued: JSON.parse(r.issued) as string[] }
}
