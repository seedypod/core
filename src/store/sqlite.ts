import Database from 'better-sqlite3'
import { and, asc, desc, eq, gte, lt, lte, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SensorId } from '../hardware/contract'
import type { AutomationRule } from '../autopilot/types'
import * as t from '../db/schema'
import { downsample } from './memory'
import type { AlertRow, Automation, AutomationRun, AnalysisPoint, AnalysisRow, AnalyzerStats, BackupRecord, Capture, DeviceSettings, FlashSample, GrowCycle, GrowStage, LightSpec, Pod, PumpSpec, Schedule, ScheduleRun, Store, TelemetryPoint } from './types'
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
    // better-sqlite3 creates the file but not its directory; a fresh install has no ./data yet.
    if (opts.url !== ':memory:') mkdirSync(dirname(resolve(opts.url)), { recursive: true })
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

  backups = {
    add: (r: Omit<BackupRecord, 'id'>): BackupRecord => rowToBackup(this.db.insert(t.backups).values(r).returning().get()),
    list: (limit = 50): BackupRecord[] => this.db.select().from(t.backups).orderBy(desc(t.backups.ts), desc(t.backups.id)).limit(limit).all().map(rowToBackup),
    lastSuccess: (destination?: BackupRecord['destination']): BackupRecord | null => {
      const r = this.db.select().from(t.backups).where(destination ? and(eq(t.backups.ok, true), eq(t.backups.destination, destination)) : eq(t.backups.ok, true)).orderBy(desc(t.backups.ts), desc(t.backups.id)).limit(1).get()
      return r ? rowToBackup(r) : null
    },
  }

  /**
   * SQLite's online backup: a consistent copy while core keeps writing (ADR-0021).
   * The copy is a single file (no WAL) and counts as set up, so a unit restored
   * from it doesn't open on Welcome.
   */
  async backupTo(path: string): Promise<void> {
    await this.sqlite.backup(path)
    const copy = new Database(path)
    try {
      copy.pragma('journal_mode = DELETE')
      copy.prepare('UPDATE device_settings SET setupComplete = 1').run()
    }
    finally {
      copy.close()
    }
  }

  flash = {
    add: (sample: FlashSample): void => {
      this.db.insert(t.flashSamples).values(sample).onConflictDoUpdate({ target: t.flashSamples.ts, set: { sectors: sample.sectors, bytes: sample.bytes } }).run()
    },
    last: (): FlashSample | null => this.db.select().from(t.flashSamples).orderBy(desc(t.flashSamples.ts)).limit(1).get() ?? null,
    since: (fromTs: string): FlashSample[] => this.db.select().from(t.flashSamples).where(gte(t.flashSamples.ts, fromTs)).orderBy(asc(t.flashSamples.ts)).all(),
    prune: (beforeTs: string): number => this.db.delete(t.flashSamples).where(lt(t.flashSamples.ts, beforeTs)).run().changes,
  }

  analyses = {
    add: (rows: AnalysisRow[]): void => {
      if (rows.length === 0) return
      this.sqlite.transaction(() => {
        for (const r of rows) {
          const values = { ...r, detail: r.detail ? JSON.stringify(r.detail) : null }
          this.db.insert(t.analysisResults).values(values).onConflictDoUpdate({
            target: [t.analysisResults.captureId, t.analysisResults.analyzer, t.analysisResults.version, t.analysisResults.slot, t.analysisResults.metric],
            set: { value: values.value, detail: values.detail, artifact: values.artifact, source: values.source, ts: values.ts, camera: values.camera },
          }).run()
        }
      })()
    },
    series: (q: { analyzer: string, version?: number, slot: number, metric: string, limit?: number }): AnalysisPoint[] => {
      const a = t.analysisResults
      const version = q.version ?? this.db.select({ v: sql<number | null>`max(${a.version})` }).from(a).where(eq(a.analyzer, q.analyzer)).get()?.v
      if (version === null || version === undefined) return []
      return this.db.select({ ts: a.ts, value: a.value, captureId: a.captureId }).from(a)
        .where(and(eq(a.analyzer, q.analyzer), eq(a.version, version), eq(a.slot, q.slot), eq(a.metric, q.metric)))
        .orderBy(desc(a.ts)).limit(q.limit ?? 200).all().reverse()
    },
    forCapture: (captureId: string): AnalysisRow[] =>
      this.db.select().from(t.analysisResults).where(eq(t.analysisResults.captureId, captureId))
        .orderBy(asc(t.analysisResults.analyzer), asc(t.analysisResults.version), asc(t.analysisResults.slot), asc(t.analysisResults.metric)).all().map(rowToAnalysis),
    range: (fromTs: string, toTs: string): AnalysisRow[] =>
      this.db.select().from(t.analysisResults).where(and(gte(t.analysisResults.ts, fromTs), lte(t.analysisResults.ts, toTs)))
        .orderBy(asc(t.analysisResults.ts), asc(t.analysisResults.id)).all().map(rowToAnalysis),
    stats: (): AnalyzerStats[] =>
      this.db.all<AnalyzerStats>(sql`SELECT analyzer, version, source, count(*) AS rows, count(DISTINCT captureId) AS captures, min(ts) AS firstTs, max(ts) AS lastTs
        FROM analysis_results GROUP BY analyzer, version, source ORDER BY analyzer, version`),
  }

  automations = {
    list: (): Automation[] => this.db.select().from(t.automations).orderBy(asc(t.automations.id)).all().map(rowToAutomation),
    get: (id: number): Automation | null => {
      const r = this.db.select().from(t.automations).where(eq(t.automations.id, id)).get()
      return r ? rowToAutomation(r) : null
    },
    create: (rule: Omit<AutomationRule, 'id'>, ts: string): Automation => {
      const r = this.db.insert(t.automations).values({ ...automationColumns(rule), createdAt: ts, updatedAt: ts }).returning().get()
      return rowToAutomation(r)
    },
    update: (id: number, patch: Partial<Omit<AutomationRule, 'id'>>, ts: string): Automation | null => {
      const r = this.db.update(t.automations).set({ ...automationColumns(patch), updatedAt: ts }).where(eq(t.automations.id, id)).returning().get()
      return r ? rowToAutomation(r) : null
    },
    remove: (id: number): boolean => {
      this.db.delete(t.automationRuns).where(eq(t.automationRuns.automationId, id)).run()
      return this.db.delete(t.automations).where(eq(t.automations.id, id)).run().changes > 0
    },
    addRun: (run: Omit<AutomationRun, 'id'>): void => {
      this.db.insert(t.automationRuns).values({ ...run, detail: JSON.stringify(run.detail ?? {}) }).run()
    },
    runs: (q?: { automationId?: number, limit?: number }): AutomationRun[] => {
      const base = this.db.select().from(t.automationRuns)
      const rows = (q?.automationId !== undefined ? base.where(eq(t.automationRuns.automationId, q.automationId)) : base)
        .orderBy(desc(t.automationRuns.id)).limit(q?.limit ?? 100).all()
      return rows.map(r => ({ ...r, detail: JSON.parse(r.detail) as unknown }))
    },
    pruneRuns: (beforeTs: string): number => this.db.delete(t.automationRuns).where(lt(t.automationRuns.firedAt, beforeTs)).run().changes,
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

function rowToAnalysis(r: typeof t.analysisResults.$inferSelect): AnalysisRow {
  return { captureId: r.captureId, ts: r.ts, camera: r.camera, analyzer: r.analyzer, version: r.version, source: r.source, slot: r.slot, metric: r.metric, value: r.value, detail: r.detail ? JSON.parse(r.detail) as Record<string, unknown> : null, artifact: r.artifact }
}

function automationColumns(r: Partial<Omit<AutomationRule, 'id'>>) {
  const out: Partial<typeof t.automations.$inferInsert> = {}
  if (r.name !== undefined) out.name = r.name
  if (r.enabled !== undefined) out.enabled = r.enabled
  if (r.dryRun !== undefined) out.dryRun = r.dryRun
  if (r.priority !== undefined) out.priority = r.priority
  if (r.cooldownMin !== undefined) out.cooldownMin = r.cooldownMin
  if (r.trigger !== undefined) out.trigger = JSON.stringify(r.trigger)
  if (r.conditions !== undefined) out.conditions = JSON.stringify(r.conditions)
  if (r.actions !== undefined) out.actions = JSON.stringify(r.actions)
  return out as typeof t.automations.$inferInsert
}

function rowToAutomation(r: typeof t.automations.$inferSelect): Automation {
  return { ...r, trigger: JSON.parse(r.trigger) as AutomationRule['trigger'], conditions: JSON.parse(r.conditions) as AutomationRule['conditions'], actions: JSON.parse(r.actions) as AutomationRule['actions'] }
}

function rowToBackup(r: typeof t.backups.$inferSelect): BackupRecord {
  return { ...r, destination: r.destination as BackupRecord['destination'] }
}
