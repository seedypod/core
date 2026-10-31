/**
 * Store — the persistence boundary. `SqliteStore` (drizzle, on the unit) and
 * `MemoryStore` (tests, browser demo) implement the same interface, so every
 * router, the scheduler and the grow cycle are storage-agnostic.
 */
import type { AutomationRule, RunOutcome } from '../autopilot/types'
import type { SensorId } from '../hardware/contract'

export interface DeviceSettings {
  unitName: string
  timezone: string
  temperatureUnit: 'C' | 'F'
  waterFullCm: number
  waterEmptyCm: number
  tankCapacityL: number
  thinningReminderDays: number
  rootCheckReminderDays: number
  harvestReminderDays: number
  nutrientReminderDays: number
  apiKey: string
  mqttUrl: string | null
  mqttUsername: string | null
  mqttPassword: string | null
  mqttTlsEnabled: boolean
  mqttTlsInsecure: boolean
  captureIntervalMin: number
  primaryAnalyzer: string
  analysisArtifacts: boolean
  analysisIngestToken: string
  mirrorEndpoint: string | null
  mirrorBucket: string | null
  mirrorRegion: string
  mirrorPrefix: string
  mirrorAccessKeyId: string | null
  mirrorSecretAccessKey: string | null
  autopilotEnabled: boolean
  /** False until the owner picks Welcome → Set up a new garden, or restores a backup. */
  setupComplete: boolean
  updatedAt: string
}

export interface LightSetpoint {
  /** Minutes past local midnight, 0–1439. */
  minute: number
  /** 0–100. */
  level: number
}
export interface LightSpec { setpoints: LightSetpoint[] }
export interface PumpSpec { minute: number, durationS: number, level?: number }

export interface Schedule {
  id: string
  kind: 'light' | 'pump'
  name: string
  enabled: boolean
  /** Bitmask Mon=1 … Sun=64. */
  days: number
  spec: LightSpec | PumpSpec
  createdAt: string
  updatedAt: string
}

export interface ScheduleRun { scheduleId: string, key: string, firedAt: string, result: string }

export interface AlertRow {
  id: number
  kind: string
  active: boolean
  detail: string
  raisedAt: string
  clearedAt: string | null
  acknowledgedAt: string | null
  dismissedAt: string | null
}

export type GrowStage = 'germination' | 'seedling' | 'vegetative' | 'harvest' | 'ended'
export interface GrowCycle {
  id: string
  startedAt: string
  endedAt: string | null
  stage: GrowStage
  notes: string
  issued: string[]
}

export type PodStatus = 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention'
export interface Pod {
  slot: number
  plant: string | null
  plantedAt: string | null
  status: PodStatus
  notes: string
  updatedAt: string
}

export interface Capture { id: string, camera: 'upper' | 'lower', ts: string, path: string, bytes: number }
/** One measurement of one pod in one capture by one analyser (ADR-0019). */
export interface AnalysisRow {
  captureId: string
  ts: string
  camera: 'upper' | 'lower'
  analyzer: string
  version: number
  source: 'device' | 'remote'
  slot: number
  metric: string
  value: number
  detail: Record<string, unknown> | null
  artifact: string | null
}
export interface AnalysisPoint { ts: string, value: number, captureId: string }
/** What the table holds per analyser@version. */
export interface AnalyzerStats { analyzer: string, version: number, source: 'device' | 'remote', rows: number, captures: number, firstTs: string, lastTs: string }
export interface TelemetryPoint { ts: string, sensor: SensorId, value: number }
/** One off-card backup attempt (ADR-0021). A finished download counts as a success. */
export interface BackupRecord {
  id: number
  ts: string
  destination: 'download' | 'bucket'
  name: string
  bytes: number
  ok: boolean
  detail: string
}
/** One sample of the SD card's sectors-written counter; `bytes` were written since the previous sample. */
export interface FlashSample { ts: string, sectors: number, bytes: number }

export interface Store {
  settings: {
    get(): DeviceSettings
    update(patch: Partial<Omit<DeviceSettings, 'updatedAt'>>): DeviceSettings
  }
  schedules: {
    list(): Schedule[]
    get(id: string): Schedule | null
    upsert(s: Omit<Schedule, 'createdAt' | 'updatedAt'> & Partial<Pick<Schedule, 'createdAt'>>): Schedule
    remove(id: string): boolean
    /** Returns false if the key was already recorded (idempotent firing). */
    recordRun(run: ScheduleRun): boolean
    recentRuns(limit?: number): ScheduleRun[]
  }
  alerts: {
    list(opts?: { activeOnly?: boolean }): AlertRow[]
    /** Raise (or refresh detail of) the active alert of this kind. */
    raise(kind: string, detail: string, ts: string): AlertRow
    clear(kind: string, ts: string): AlertRow | null
    acknowledge(id: number, ts: string): AlertRow | null
    dismiss(id: number, ts: string): AlertRow | null
  }
  grow: {
    current(): GrowCycle | null
    start(ts: string, notes?: string): GrowCycle
    setStage(stage: GrowStage, ts: string): GrowCycle | null
    markIssued(reminder: string): void
    end(ts: string): GrowCycle | null
    history(): GrowCycle[]
  }
  pods: {
    list(): Pod[]
    update(slot: number, patch: Partial<Omit<Pod, 'slot' | 'updatedAt'>>, ts: string): Pod
  }
  captures: {
    add(c: Capture): void
    list(camera?: 'upper' | 'lower', limit?: number): Capture[]
    get(id: string): Capture | null
    prune(camera: 'upper' | 'lower', keep: number): Capture[]
  }
  telemetry: {
    add(points: TelemetryPoint[]): void
    range(sensor: SensorId, fromTs: string, toTs: string, maxPoints?: number): TelemetryPoint[]
  }
  counters: {
    add(key: string, delta: number, ts: string): number
    get(key: string): number
  }
  backups: {
    add(r: Omit<BackupRecord, 'id'>): BackupRecord
    /** Newest first. */
    list(limit?: number): BackupRecord[]
    lastSuccess(destination?: BackupRecord['destination']): BackupRecord | null
  }
  flash: {
    add(sample: FlashSample): void
    last(): FlashSample | null
    /** Samples at or after `fromTs`, oldest first. */
    since(fromTs: string): FlashSample[]
    prune(beforeTs: string): number
  }
  analyses: {
    /** Upsert on (capture, analyser, version, slot, metric): re-running is idempotent. */
    add(rows: AnalysisRow[]): void
    /** Oldest → newest for one pod; `version` defaults to the newest version that has rows. */
    series(q: { analyzer: string, version?: number, slot: number, metric: string, limit?: number }): AnalysisPoint[]
    forCapture(captureId: string): AnalysisRow[]
    /** Rows whose capture time falls in [fromTs, toTs], oldest first. */
    range(fromTs: string, toTs: string): AnalysisRow[]
    stats(): AnalyzerStats[]
  }
  automations: {
    list(): Automation[]
    get(id: number): Automation | null
    create(rule: Omit<AutomationRule, 'id'>, ts: string): Automation
    update(id: number, patch: Partial<Omit<AutomationRule, 'id'>>, ts: string): Automation | null
    remove(id: number): boolean
    addRun(run: Omit<AutomationRun, 'id'>): void
    /** Newest first. */
    runs(q?: { automationId?: number, limit?: number }): AutomationRun[]
    /** Drop runs older than `beforeTs`; returns how many went. */
    pruneRuns(beforeTs: string): number
  }
  close(): void
}

export interface Automation extends AutomationRule { createdAt: string, updatedAt: string }
export interface AutomationRun { id: number, automationId: number, firedAt: string, outcome: RunOutcome, detail: unknown }

export const DEFAULT_SETTINGS: Omit<DeviceSettings, 'updatedAt'> = {
  unitName: 'Gardyn',
  timezone: 'UTC',
  temperatureUnit: 'C',
  waterFullCm: 5,
  waterEmptyCm: 20,
  tankCapacityL: 19,
  thinningReminderDays: 14,
  rootCheckReminderDays: 21,
  harvestReminderDays: 35,
  nutrientReminderDays: 7,
  apiKey: '',
  mqttUrl: null,
  mqttUsername: null,
  mqttPassword: null,
  mqttTlsEnabled: false,
  mqttTlsInsecure: false,
  captureIntervalMin: 60,
  primaryAnalyzer: 'green-threshold',
  analysisArtifacts: false,
  analysisIngestToken: '',
  mirrorEndpoint: null,
  mirrorBucket: null,
  mirrorRegion: 'auto',
  mirrorPrefix: '',
  mirrorAccessKeyId: null,
  mirrorSecretAccessKey: null,
  autopilotEnabled: true,
  setupComplete: false,
}
