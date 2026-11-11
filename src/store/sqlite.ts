import Database from 'better-sqlite3'
import { and, asc, desc, eq, gt, gte, lt, lte, notInArray, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SensorId } from '../hardware/contract'
import type { AutomationRule } from '../autopilot/types'
import * as t from '../db/schema'
import { downsample } from './memory'
import type { AlertRow, Automation, AutomationRun, AnalysisPoint, AnalysisRow, AnalyzerStats, BackupRecord, Capture, CustomPlant, DeviceSettings, FlashSample, GrowCycle, GrowProtocolState, GrowStage, LightSpec, PlanRow, PlantProfile, Pod, PodCodePair, PodCodeRead, PodLabel, PodLabelCursor, PodLabelValue, PumpSpec, SavedCycle, SavedSchedule, Schedule, ScheduleRun, Store, TankAction, TankActionKind, TelemetryPoint } from './types'
import { DEFAULT_SETTINGS, POD_LABELS, profileKey } from './types'

export interface SqliteStoreOptions {
  /** File path or ':memory:'. */
  url: string
  podCount?: number
  /** Override for tests; defaults to src/db/migrations next to the schema. */
  migrationsFolder?: string
}

const here = dirname(fileURLToPath(import.meta.url))

/** About ten hours of a stock unit's rows, under 1 MB: enough to ride out a bad card without growing on a 426 MB board. */
export const MAX_HELD_TELEMETRY = 5_000

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
  /** Rows waiting for the next flush (ADR-0021). */
  private heldTelemetry: TelemetryPoint[] = []
  /** A full buffer's own flush failed: new samples leave retrying to the timer until a flush lands. */
  private capFlushFailed = false
  /** Newest detail of active alerts whose rows still hold an older one, by alert id. */
  private readonly liveDetail = new Map<number, string>()

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
      this.db.insert(t.pods).values({ slot, status: 'empty', notes: '', updatedAt: now, statusSince: now }).onConflictDoNothing().run()
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
      return rows.map(r => ({ ...r, detail: this.liveDetail.get(r.id) ?? r.detail })).sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
    },
    raise: (kind: string, detail: string, ts: string, opts?: { live?: boolean }): AlertRow => {
      const existing = this.db.select().from(t.alerts).where(and(eq(t.alerts.kind, kind), eq(t.alerts.active, true))).get()
      if (existing) {
        if (opts?.live) {
          this.liveDetail.set(existing.id, detail)
        }
        else {
          this.liveDetail.delete(existing.id)
          this.db.update(t.alerts).set({ detail }).where(eq(t.alerts.id, existing.id)).run()
        }
        return { ...existing, detail }
      }
      const r = this.db.insert(t.alerts).values({ kind, active: true, detail, raisedAt: ts }).returning().get()
      return r
    },
    clear: (kind: string, ts: string): AlertRow | null => {
      const existing = this.db.select().from(t.alerts).where(and(eq(t.alerts.kind, kind), eq(t.alerts.active, true))).get()
      if (!existing) return null
      return this.db.update(t.alerts).set({ active: false, clearedAt: ts, ...this.takeLiveDetail(existing.id) }).where(eq(t.alerts.id, existing.id)).returning().get() as AlertRow
    },
    acknowledge: (id: number, ts: string): AlertRow | null =>
      this.db.update(t.alerts).set({ acknowledgedAt: ts, ...this.takeLiveDetail(id) }).where(eq(t.alerts.id, id)).returning().get() ?? null,
    dismiss: (id: number, ts: string): AlertRow | null =>
      this.db.update(t.alerts).set({ dismissedAt: ts, active: false, ...this.takeLiveDetail(id) }).where(eq(t.alerts.id, id)).returning().get() ?? null,
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
    setStart: (ts: string, stage: GrowStage, issued: string[]): GrowCycle | null => {
      const r = this.db.update(t.growCycles).set({ startedAt: ts, stage, issued: JSON.stringify(issued) }).where(sql`${t.growCycles.endedAt} IS NULL`).returning().get()
      return r ? rowToCycle(r) : null
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
    setProtocol: (patch: Partial<GrowProtocolState>): GrowCycle | null => {
      const { stageStarts, ...rest } = patch
      const r = this.db.update(t.growCycles).set({ ...rest, ...(stageStarts ? { stageStarts: JSON.stringify(stageStarts) } : {}) }).where(sql`${t.growCycles.endedAt} IS NULL`).returning().get()
      return r ? rowToCycle(r) : null
    },
    end: (ts: string): GrowCycle | null => {
      const r = this.db.update(t.growCycles).set({ endedAt: ts, stage: 'ended' }).where(sql`${t.growCycles.endedAt} IS NULL`).returning().get()
      return r ? rowToCycle(r) : null
    },
    history: (): GrowCycle[] => this.db.select().from(t.growCycles).orderBy(desc(t.growCycles.startedAt)).all().map(rowToCycle),
  }

  pods = {
    list: (): Pod[] => this.db.select().from(t.pods).orderBy(asc(t.pods.slot)).all(),
    update: (slot: number, patch: Partial<Omit<Pod, 'slot' | 'updatedAt' | 'statusSince'>>, ts: string): Pod => {
      const prev = this.db.select().from(t.pods).where(eq(t.pods.slot, slot)).get()
      if (!prev) throw new Error(`no pod ${slot}`)
      const moved = patch.status !== undefined && patch.status !== prev.status
      const r = this.db.update(t.pods).set({ ...patch, updatedAt: ts, ...(moved ? { statusSince: ts } : {}) }).where(eq(t.pods.slot, slot)).returning().get()
      if (!r) throw new Error(`no pod ${slot}`)
      return r
    },
  }

  plants = {
    list: (): PlantProfile[] => this.db.select().from(t.plantProfiles).orderBy(asc(t.plantProfiles.key)).all(),
    upsert: (p: Omit<PlantProfile, 'key' | 'updatedAt'>, ts: string): PlantProfile => {
      const row = { ...p, key: profileKey(p.name), updatedAt: ts }
      this.db.insert(t.plantProfiles).values(row).onConflictDoUpdate({ target: t.plantProfiles.key, set: row }).run()
      return row
    },
    remove: (name: string): boolean => this.db.delete(t.plantProfiles).where(eq(t.plantProfiles.key, profileKey(name))).run().changes > 0,
  }

  customPlants = {
    list: (): CustomPlant[] => this.db.select().from(t.customPlants).orderBy(asc(t.customPlants.createdAt), asc(t.customPlants.id)).all().map(rowToCustomPlant),
    get: (id: string): CustomPlant | null => {
      const r = this.db.select().from(t.customPlants).where(eq(t.customPlants.id, id)).get()
      return r ? rowToCustomPlant(r) : null
    },
    upsert: (p: Omit<CustomPlant, 'createdAt' | 'updatedAt'>, ts: string): CustomPlant => {
      const cols = { name: p.name, category: p.category, zone: p.zone, harvestMinMonths: p.harvestMonths[0], harvestMaxMonths: p.harvestMonths[1], careLevel: p.careLevel, size: p.size, succession: p.succession, source: p.source, updatedAt: ts }
      this.db.insert(t.customPlants).values({ ...cols, id: p.id, createdAt: ts }).onConflictDoUpdate({ target: t.customPlants.id, set: cols }).run()
      return this.customPlants.get(p.id) as CustomPlant
    },
    remove: (id: string): boolean => this.db.delete(t.customPlants).where(eq(t.customPlants.id, id)).run().changes > 0,
  }

  scheduleLibrary = {
    list: (): SavedSchedule[] => this.db.select().from(t.scheduleLibrary).orderBy(asc(t.scheduleLibrary.createdAt), asc(t.scheduleLibrary.id)).all().map(rowToSaved),
    get: (id: string): SavedSchedule | null => {
      const r = this.db.select().from(t.scheduleLibrary).where(eq(t.scheduleLibrary.id, id)).get()
      return r ? rowToSaved(r) : null
    },
    upsert: (s: Omit<SavedSchedule, 'createdAt' | 'updatedAt' | 'lastUsedAt'>, ts: string): SavedSchedule => {
      const cols = { name: s.name, cycles: JSON.stringify(s.cycles), lightPresetId: s.lightPresetId, updatedAt: ts }
      this.db.insert(t.scheduleLibrary).values({ ...cols, id: s.id, createdAt: ts }).onConflictDoUpdate({ target: t.scheduleLibrary.id, set: cols }).run()
      return this.scheduleLibrary.get(s.id) as SavedSchedule
    },
    markUsed: (id: string, ts: string): void => {
      this.db.update(t.scheduleLibrary).set({ lastUsedAt: ts }).where(eq(t.scheduleLibrary.id, id)).run()
    },
    remove: (id: string): boolean => this.db.delete(t.scheduleLibrary).where(eq(t.scheduleLibrary.id, id)).run().changes > 0,
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
      this.heldTelemetry.push(...pts)
      if (this.heldTelemetry.length < MAX_HELD_TELEMETRY) return
      if (!this.capFlushFailed) {
        this.telemetry.flush()
        this.capFlushFailed = this.heldTelemetry.length > 0
      }
      // A card that refuses writes must not grow memory: the oldest rows go first.
      this.heldTelemetry.splice(0, this.heldTelemetry.length - MAX_HELD_TELEMETRY)
    },
    range: (sensor: SensorId, fromTs: string, toTs: string, maxPoints = 500): TelemetryPoint[] => {
      const rows = this.db.select({ ts: t.telemetry.ts, sensor: t.telemetry.sensor, value: t.telemetry.value }).from(t.telemetry)
        .where(and(eq(t.telemetry.sensor, sensor), gte(t.telemetry.ts, fromTs), lte(t.telemetry.ts, toTs))).orderBy(asc(t.telemetry.ts)).all() as TelemetryPoint[]
      // Merged rather than flushed, so a chart polling every minute costs no write.
      const held = this.heldTelemetry.filter(p => p.sensor === sensor && p.ts >= fromTs && p.ts <= toTs)
      return downsample(held.length ? [...rows, ...held].sort((a, b) => a.ts.localeCompare(b.ts)) : rows, maxPoints)
    },
    flush: (): void => {
      if (this.heldTelemetry.length === 0) return
      try {
        this.db.insert(t.telemetry).values(this.heldTelemetry).run()
        this.heldTelemetry = []
        this.capFlushFailed = false
      }
      catch (e) {
        console.warn(`telemetry flush failed, holding ${this.heldTelemetry.length} rows: ${(e as Error).message}`)
      }
    },
    thin: (sensors: readonly SensorId[], fromTs: string, toTs: string, bucketMin: number): number => {
      // ts is ISO 8601, so the first 14 characters end at the hour, and the minutes follow.
      // Inlined: a bound JS number arrives as a REAL, and the division wouldn't round down.
      const minutes = sql`CAST(substr(${t.telemetry.ts}, 15, 2) AS INTEGER) / ${sql.raw(String(Math.trunc(bucketMin)))}`
      // One transaction, or each sensor would write the same table pages to the WAL again.
      return this.sqlite.transaction(() => sensors.reduce((removed, sensor) => {
        // Per sensor, because the only index that reaches ts starts with it.
        const window = and(eq(t.telemetry.sensor, sensor), gte(t.telemetry.ts, fromTs), lt(t.telemetry.ts, toTs))
        const firsts = this.db.select({ id: sql<number>`min(${t.telemetry.id})` }).from(t.telemetry).where(window).groupBy(sql`substr(${t.telemetry.ts}, 1, 14)`, minutes)
        return removed + this.db.delete(t.telemetry).where(and(window, notInArray(t.telemetry.id, firsts))).run().changes
      }, 0))()
    },
    oldestTs: (): string | null => this.db.select({ ts: t.telemetry.ts }).from(t.telemetry).orderBy(asc(t.telemetry.id)).limit(1).get()?.ts ?? null,
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
    this.telemetry.flush()
    // A copy without these rows would look fine and lose them on a restore.
    if (this.heldTelemetry.length > 0) throw new Error(`the card refused ${this.heldTelemetry.length} telemetry rows, so a backup would leave them out`)
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
    removeDevice: (captureId: string): void => {
      this.db.delete(t.analysisResults).where(and(eq(t.analysisResults.captureId, captureId), eq(t.analysisResults.source, 'device'))).run()
    },
    range: (fromTs: string, toTs: string): AnalysisRow[] =>
      this.db.select().from(t.analysisResults).where(and(gte(t.analysisResults.ts, fromTs), lte(t.analysisResults.ts, toTs)))
        .orderBy(asc(t.analysisResults.ts), asc(t.analysisResults.id)).all().map(rowToAnalysis),
    stats: (): AnalyzerStats[] =>
      this.db.all<AnalyzerStats>(sql`SELECT analyzer, version, source, count(*) AS rows, count(DISTINCT captureId) AS captures, min(ts) AS firstTs, max(ts) AS lastTs
        FROM analysis_results GROUP BY analyzer, version, source ORDER BY analyzer, version`),
  }

  podLabels = {
    set: (l: PodLabel): PodLabel => rowToLabel(this.db.insert(t.podLabels).values(l).onConflictDoUpdate({
      target: [t.podLabels.captureId, t.podLabels.slot],
      // The right-hand sides read the row as it was, so a kept snapshot keeps its date too.
      set: {
        label: l.label,
        labelledAt: l.labelledAt,
        ts: l.ts,
        camera: l.camera,
        plant: sql`coalesce(${t.podLabels.plant}, excluded.plant)`,
        plantedAt: sql`CASE WHEN ${t.podLabels.plant} IS NULL THEN excluded.plantedAt ELSE ${t.podLabels.plantedAt} END`,
      },
    }).returning().get() as typeof t.podLabels.$inferSelect),
    remove: (captureId: string, slot: number): boolean =>
      this.db.delete(t.podLabels).where(and(eq(t.podLabels.captureId, captureId), eq(t.podLabels.slot, slot))).run().changes > 0,
    forCapture: (captureId: string): PodLabel[] =>
      this.db.select().from(t.podLabels).where(eq(t.podLabels.captureId, captureId)).orderBy(asc(t.podLabels.slot)).all().map(rowToLabel),
    range: (fromTs: string, toTs: string): PodLabel[] =>
      this.db.select().from(t.podLabels).where(and(gte(t.podLabels.ts, fromTs), lte(t.podLabels.ts, toTs)))
        .orderBy(asc(t.podLabels.ts), asc(t.podLabels.captureId), asc(t.podLabels.slot)).all().map(rowToLabel),
    list: (q: { label?: PodLabelValue, camera?: 'upper' | 'lower', limit: number, before?: PodLabelCursor }): PodLabel[] => {
      const b = q.before
      return this.db.select().from(t.podLabels).where(and(
        q.label ? eq(t.podLabels.label, q.label) : undefined,
        q.camera ? eq(t.podLabels.camera, q.camera) : undefined,
        b ? or(lt(t.podLabels.ts, b.ts), and(eq(t.podLabels.ts, b.ts), or(lt(t.podLabels.captureId, b.captureId), and(eq(t.podLabels.captureId, b.captureId), gt(t.podLabels.slot, b.slot))))) : undefined,
      )).orderBy(desc(t.podLabels.ts), desc(t.podLabels.captureId), asc(t.podLabels.slot)).limit(q.limit).all().map(rowToLabel)
    },
    counts: (): Record<PodLabelValue, number> => {
      const out = Object.fromEntries(POD_LABELS.map(l => [l, 0])) as Record<PodLabelValue, number>
      for (const r of this.db.select({ label: t.podLabels.label, n: sql<number>`count(*)` }).from(t.podLabels).groupBy(t.podLabels.label).all()) out[r.label] = r.n
      return out
    },
    captures: (limit = 50): Array<{ captureId: string, ts: string, camera: 'upper' | 'lower', pods: number }> =>
      this.db.select({ captureId: t.podLabels.captureId, ts: t.podLabels.ts, camera: t.podLabels.camera, pods: sql<number>`count(*)` }).from(t.podLabels)
        .groupBy(t.podLabels.captureId).orderBy(desc(t.podLabels.ts), asc(t.podLabels.captureId)).limit(limit).all(),
  }

  podCodes = {
    pairs: (): PodCodePair[] => this.db.select().from(t.podCodes).orderBy(asc(t.podCodes.code)).all(),
    pair: (code: string): PodCodePair | null => this.db.select().from(t.podCodes).where(eq(t.podCodes.code, code)).get() ?? null,
    confirm: (code: string, plant: string, ts: string): PodCodePair =>
      this.db.insert(t.podCodes).values({ code, plant, confirmedAt: ts })
        .onConflictDoUpdate({ target: t.podCodes.code, set: { plant, confirmedAt: ts } }).returning().get(),
    forget: (code: string): boolean => this.db.delete(t.podCodes).where(eq(t.podCodes.code, code)).run().changes > 0,
    reads: (): PodCodeRead[] => this.db.select().from(t.podCodeReads).orderBy(asc(t.podCodeReads.slot)).all(),
    setReads: (camera: 'upper' | 'lower', reads: PodCodeRead[]): void => {
      this.db.transaction((tx) => {
        tx.delete(t.podCodeReads).where(eq(t.podCodeReads.camera, camera)).run()
        if (reads.length) tx.insert(t.podCodeReads).values(reads.map(r => ({ ...r, camera }))).onConflictDoUpdate({ target: t.podCodeReads.slot, set: { camera, code: sql`excluded.code`, confidence: sql`excluded.confidence`, ts: sql`excluded.ts` } }).run()
      })
    },
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

  tankActions = {
    add: (a: Omit<TankAction, 'id' | 'createdAt'>, createdAt: string): TankAction => this.db.insert(t.tankActions).values({ ...a, createdAt }).returning().get(),
    list: (q?: { kind?: TankActionKind, limit?: number }): TankAction[] => {
      const base = this.db.select().from(t.tankActions)
      return (q?.kind ? base.where(eq(t.tankActions.kind, q.kind)) : base).orderBy(desc(t.tankActions.ts), desc(t.tankActions.id)).limit(q?.limit ?? 100).all()
    },
    remove: (id: number): boolean => this.db.delete(t.tankActions).where(eq(t.tankActions.id, id)).run().changes > 0,
  }

  plans = {
    list: (): PlanRow[] => this.db.select().from(t.plans).orderBy(desc(t.plans.updatedAt)).all().map(rowToPlan),
    get: (id: string): PlanRow | null => {
      const r = this.db.select().from(t.plans).where(eq(t.plans.id, id)).get()
      return r ? rowToPlan(r) : null
    },
    save: (p: Omit<PlanRow, 'createdAt' | 'updatedAt' | 'appliedAt' | 'issued'>): PlanRow => {
      const now = new Date().toISOString()
      const values = { id: p.id, name: p.name, model: p.model, mode: p.mode, request: JSON.stringify(p.request), layout: JSON.stringify(p.layout), sowing: JSON.stringify(p.sowing), createdAt: now, updatedAt: now }
      this.db.insert(t.plans).values(values).onConflictDoUpdate({ target: t.plans.id, set: { name: values.name, model: values.model, mode: values.mode, request: values.request, layout: values.layout, sowing: values.sowing, updatedAt: now } }).run()
      return this.plans.get(p.id) as PlanRow
    },
    remove: (id: string): boolean => this.db.delete(t.plans).where(eq(t.plans.id, id)).run().changes > 0,
    markApplied: (id: string, ts: string): PlanRow | null => {
      const r = this.db.update(t.plans).set({ appliedAt: ts }).where(eq(t.plans.id, id)).returning().get()
      return r ? rowToPlan(r) : null
    },
    markIssued: (id: string, key: string): void => {
      const p = this.plans.get(id)
      if (!p || p.issued.includes(key)) return
      this.db.update(t.plans).set({ issued: JSON.stringify([...p.issued, key]) }).where(eq(t.plans.id, id)).run()
    },
  }

  close(): void {
    this.telemetry.flush()
    this.sqlite.close()
  }

  /** The held detail as a column patch, to persist with the alert's next state change. */
  private takeLiveDetail(id: number): { detail?: string } {
    const detail = this.liveDetail.get(id)
    this.liveDetail.delete(id)
    return detail === undefined ? {} : { detail }
  }
}

function rowToSchedule(r: typeof t.schedules.$inferSelect): Schedule {
  return { ...r, spec: JSON.parse(r.spec) as LightSpec | PumpSpec }
}

function rowToCustomPlant({ harvestMinMonths, harvestMaxMonths, ...r }: typeof t.customPlants.$inferSelect): CustomPlant {
  return { ...r, harvestMonths: [harvestMinMonths, harvestMaxMonths] }
}

function rowToPlan(r: typeof t.plans.$inferSelect): PlanRow {
  return { ...r, request: JSON.parse(r.request) as PlanRow['request'], layout: JSON.parse(r.layout) as PlanRow['layout'], sowing: JSON.parse(r.sowing) as PlanRow['sowing'], issued: JSON.parse(r.issued) as string[] }
}

function rowToSaved(r: typeof t.scheduleLibrary.$inferSelect): SavedSchedule {
  return { ...r, cycles: JSON.parse(r.cycles) as SavedCycle[] }
}

function rowToCycle(r: typeof t.growCycles.$inferSelect): GrowCycle {
  return { ...r, issued: JSON.parse(r.issued) as string[], stageStarts: JSON.parse(r.stageStarts) as Record<string, string> }
}

function rowToAnalysis(r: typeof t.analysisResults.$inferSelect): AnalysisRow {
  return { captureId: r.captureId, ts: r.ts, camera: r.camera, analyzer: r.analyzer, version: r.version, source: r.source, slot: r.slot, metric: r.metric, value: r.value, detail: r.detail ? JSON.parse(r.detail) as Record<string, unknown> : null, artifact: r.artifact }
}

function rowToLabel(r: typeof t.podLabels.$inferSelect): PodLabel {
  return { captureId: r.captureId, ts: r.ts, camera: r.camera, slot: r.slot, label: r.label, labelledAt: r.labelledAt, plant: r.plant, plantedAt: r.plantedAt }
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
