/**
 * Store — the persistence boundary. `SqliteStore` (drizzle, on the unit) and
 * `MemoryStore` (tests, browser demo) implement the same interface, so every
 * router, the scheduler and the grow cycle are storage-agnostic.
 */
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
export interface PodGrowthPoint { ts: string, slot: number, green: number, captureId: string }
export interface TelemetryPoint { ts: string, sensor: SensorId, value: number }

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
  podGrowth: {
    add(points: PodGrowthPoint[]): void
    /** Oldest → newest for one slot. */
    series(slot: number, limit?: number): PodGrowthPoint[]
    /** Latest point per slot. */
    latest(): PodGrowthPoint[]
  }
  close(): void
}

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
}
