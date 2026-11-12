/**
 * Store — the persistence boundary. `SqliteStore` (drizzle, on the unit) and
 * `MemoryStore` (tests, browser demo) implement the same interface, so every
 * router, the scheduler and the grow cycle are storage-agnostic.
 */
import type { AutomationRule, RunOutcome } from '../autopilot/types'
import type { SensorId } from '../hardware/contract'
import type { Category, Succession, Zone } from '../plants/catalog'
import type { PlanResult, SowingWave } from '../plants/planner'
import type { RegionCalibration } from '../vision/regions'

export interface DeviceSettings {
  unitName: string
  timezone: string
  /** Where the unit is, for curves that follow sunrise and sunset; null until the owner sets it. */
  latitude: number | null
  longitude: number | null
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
  /** How often held telemetry goes to the card in one transaction (ADR-0021); a power cut loses at most this much. */
  telemetryFlushMin: number
  primaryAnalyzer: string
  analysisArtifacts: boolean
  /** Move the pump cycles to the next growth stage's watering preset as the plants age. */
  followGrowCycle: boolean
  /** Light curves Your schedules turned off for a schedule's light preset, to turn back on; null when none. */
  libraryLightsOff: string[] | null
  analysisIngestToken: string
  /** Pod boxes the owner moved on the cameras' stills (#143); null keeps the measured defaults. */
  podRegions: RegionCalibration | null
  mirrorEndpoint: string | null
  mirrorBucket: string | null
  mirrorRegion: string
  mirrorPrefix: string
  mirrorAccessKeyId: string | null
  mirrorSecretAccessKey: string | null
  autopilotEnabled: boolean
  /** HomeKit bridge (ADR 0023); off until turned on in Settings. Changed only through `homekit.setEnabled`. */
  homekitEnabled: boolean
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
/**
 * A curve that follows the sun: each day its setpoints are rewritten from
 * that day's sunrise and sunset, stretched or trimmed about midday to
 * between `minHours` and `maxHours` of full light, and moved `shiftMin`.
 */
export interface SunFollow {
  minHours: number
  maxHours: number
  /** How long each sunrise and sunset ramp takes, centred on the light's on and off times. */
  rampMin: number
  /** Minutes later (or earlier, negative) than the sun's midday the window centres on. */
  shiftMin: number
  /** Auto: take minHours and maxHours from the grow protocol instead (`AUTO_HOURS`). */
  auto?: boolean
}
export interface LightSpec { setpoints: LightSetpoint[], sun?: SunFollow }
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
  /** The grow protocol (ADR-0030); null until germination ends, chosen by the planted crops. */
  protocolId: string | null
  /** Days added to days-since-sowing for the protocol day: Advance and Release move it. */
  shiftDays: number
  /** The held stage and since when, or both null. */
  holdStageId: string | null
  holdSince: string | null
  /** What comes after the protocol: stay in maintenance, switch to `thenScheduleId` when maintenance begins, or a reminder at first harvest. */
  thenKind: ThenKind
  thenScheduleId: string | null
  /** When the chosen Then fired; choosing again clears it. */
  thenDoneAt: string | null
  /** The day each stage began on the unit's calendar, recorded when Advance or Release move the clock. */
  stageStarts: Record<string, string>
}

export type ThenKind = 'stay' | 'schedule' | 'remind'
/** The protocol fields of a grow cycle, as `grow.setProtocol` takes them. */
export type GrowProtocolState = Pick<GrowCycle, 'protocolId' | 'shiftDays' | 'holdStageId' | 'holdSince' | 'thenKind' | 'thenScheduleId' | 'thenDoneAt' | 'stageStarts'>

/** One pump cycle of a saved schedule; `days` is the weekday mask (bit 0 = Monday). */
export interface SavedCycle { minute: number, durationS: number, days: number }
/** One of Your schedules (ADR-0030): a named set of pump cycles, with a light preset if it sets the light. */
export interface SavedSchedule {
  id: string
  name: string
  cycles: SavedCycle[]
  lightPresetId: string | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export type PodStatus = 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention'
export interface Pod {
  slot: number
  plant: string | null
  plantedAt: string | null
  status: PodStatus
  notes: string
  updatedAt: string
  /** When the status last changed. */
  statusSince: string | null
  /** The last time the pod was cut (ADR-0022). */
  lastHarvestAt: string | null
}

/** A plant profile's key: its name trimmed and in lower case, so "Basil " and "basil" are one profile. */
export const profileKey = (name: string): string => name.trim().toLowerCase()

/** Per-crop harvest knowledge (ADR-0022); every field but the name is optional. */
export interface PlantProfile {
  /** The name in lower case, trimmed: what pods are matched by. */
  key: string
  name: string
  harvestMinDays: number | null
  harvestMaxDays: number | null
  targetCover: number | null
  notes: string
  source: 'user' | 'agent'
  updatedAt: string
}

/** A plant added to the planner catalog on this unit (#130), merged after Gardyn's built-in ones. */
export interface CustomPlant {
  /** Slug of the name at creation; stable across renames. */
  id: string
  name: string
  category: Category
  zone: Zone
  /** First harvest window in months after starting the yCube. */
  harvestMonths: [number, number]
  careLevel: 'beginner' | 'intermediate' | 'expert' | null
  /** 'large' plants shade neighbours; the planner spaces them apart. */
  size: 'large' | 'normal'
  succession: Succession
  source: 'user' | 'agent'
  createdAt: string
  updatedAt: string
}

export interface Capture { id: string, camera: 'upper' | 'lower', ts: string, path: string, bytes: number }

/** A saved pod plan: what was asked for, where it goes, and when each wave is sown. */
export interface PlanRow {
  id: string
  name: string
  model: 'home' | 'studio' | 'nursery'
  mode: 'staggered' | 'batch'
  request: { plantId: string, count: number }[]
  layout: PlanResult
  sowing: SowingWave[]
  createdAt: string
  updatedAt: string
  appliedAt: string | null
  /** Sow reminders already raised, so each fires once. */
  issued: string[]
}
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
/** What can be done to the tank (ADR-0029); chores count from the last one of their kind. */
export const TANK_ACTION_KINDS = ['feed', 'top_off', 'refresh', 'ph_down', 'ph_up', 'clean', 'trim_roots', 'thin', 'other'] as const
export type TankActionKind = typeof TANK_ACTION_KINDS[number]
export const TANK_UNITS = ['tsp', 'tbsp', 'mL', 'L', 'gal', 'g'] as const
export type TankUnit = typeof TANK_UNITS[number]

/** One thing done to the tank, so readings can be attributed to it: "fed 1 tsp MaxiGro". */
export interface TankAction {
  id: number
  /** When it was done. */
  ts: string
  kind: TankActionKind
  amount: number | null
  unit: TankUnit | null
  product: string | null
  note: string
  source: 'user' | 'agent'
  /** When it was logged. */
  createdAt: string
}

/**
 * What a pod shows in a capture (#184), the classes a pod classifier is trained on.
 * `empty` is a capped pod with no yCube; `seeded` has a yCube in but nothing up yet.
 */
export const POD_LABELS = ['empty', 'seeded', 'sprouted', 'growing', 'ready', 'unhealthy'] as const
export type PodLabelValue = typeof POD_LABELS[number]

/** The grower's label for one pod in one capture. */
export interface PodLabel {
  captureId: string
  /** The capture's time and camera. */
  ts: string
  camera: 'upper' | 'lower'
  slot: number
  label: PodLabelValue
  labelledAt: string
  /** The pod's plant and sowing date when it was first labelled; null when it had none. */
  plant: string | null
  plantedAt: string | null
}

/** Where a page of labels ends: the last row's capture time, capture and pod. */
export interface PodLabelCursor { ts: string, captureId: string, slot: number }

/**
 * A yCube dot code (#224): four marks read away from the solid dot, each `o`
 * open, `|` bar, `/` slanted bar or `h` half filled.
 */
export const POD_CODE = /^[o|/h]{4}$/

/** A code the owner has said is this plant (#224). Only confirmed pairs are kept. */
export interface PodCodePair {
  code: string
  plant: string
  confirmedAt: string
}

/** What the last pod-ID still of a pod's camera read under it (#224). */
export interface PodCodeRead {
  slot: number
  camera: 'upper' | 'lower'
  /** Null when nothing was read with enough confidence. */
  code: string | null
  confidence: number
  /** When the pod-ID still was taken. */
  ts: string
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
    /**
     * Raise (or refresh detail of) the active alert of this kind. A raise is always written.
     * `live` marks a refresh as a reading that changes every sample: it stays in memory, `list`
     * shows it, and it reaches the row with the next clear, acknowledge or dismiss (ADR-0021).
     */
    raise(kind: string, detail: string, ts: string, opts?: { live?: boolean }): AlertRow
    clear(kind: string, ts: string): AlertRow | null
    acknowledge(id: number, ts: string): AlertRow | null
    dismiss(id: number, ts: string): AlertRow | null
  }
  grow: {
    current(): GrowCycle | null
    start(ts: string, notes?: string): GrowCycle
    /** Move the open cycle's start, with its stage and issued reminders as of then; null with none open. */
    setStart(ts: string, stage: GrowStage, issued: string[]): GrowCycle | null
    setStage(stage: GrowStage, ts: string): GrowCycle | null
    markIssued(reminder: string): void
    /** Change the open cycle's protocol fields; null with no open cycle. */
    setProtocol(patch: Partial<GrowProtocolState>): GrowCycle | null
    end(ts: string): GrowCycle | null
    history(): GrowCycle[]
  }
  pods: {
    list(): Pod[]
    /** A changed status also moves `statusSince` to `ts`. */
    update(slot: number, patch: Partial<Omit<Pod, 'slot' | 'updatedAt' | 'statusSince'>>, ts: string): Pod
  }
  plants: {
    list(): PlantProfile[]
    upsert(p: Omit<PlantProfile, 'key' | 'updatedAt'>, ts: string): PlantProfile
    remove(name: string): boolean
  }
  customPlants: {
    /** Oldest first. */
    list(): CustomPlant[]
    get(id: string): CustomPlant | null
    upsert(p: Omit<CustomPlant, 'createdAt' | 'updatedAt'>, ts: string): CustomPlant
    remove(id: string): boolean
  }
  scheduleLibrary: {
    /** Oldest first. */
    list(): SavedSchedule[]
    get(id: string): SavedSchedule | null
    upsert(s: Omit<SavedSchedule, 'createdAt' | 'updatedAt' | 'lastUsedAt'>, ts: string): SavedSchedule
    markUsed(id: string, ts: string): void
    remove(id: string): boolean
  }
  captures: {
    add(c: Capture): void
    list(camera?: 'upper' | 'lower', limit?: number): Capture[]
    get(id: string): Capture | null
    prune(camera: 'upper' | 'lower', keep: number): Capture[]
  }
  telemetry: {
    /** Held in memory until the next `flush` (ADR-0021); `range` sees it straight away. */
    add(points: TelemetryPoint[]): void
    range(sensor: SensorId, fromTs: string, toTs: string, maxPoints?: number): TelemetryPoint[]
    /** Writes held rows in one transaction. A failed write keeps them for the next try. */
    flush(): void
    /** Keeps each sensor's first row of each `bucketMin` in [fromTs, toTs), in one transaction, and says how many went. */
    thin(sensors: readonly SensorId[], fromTs: string, toTs: string, bucketMin: number): number
    /** The first stored row's time, which is where thinning starts. */
    oldestTs(): string | null
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
    /** Remove what the unit itself scored for one capture; remote results stay. */
    removeDevice(captureId: string): void
    /** Rows whose capture time falls in [fromTs, toTs], oldest first. */
    range(fromTs: string, toTs: string): AnalysisRow[]
    stats(): AnalyzerStats[]
  }
  podLabels: {
    /**
     * Upsert on (capture, slot): relabelling a pod replaces its label. The plant
     * snapshot from the first labelling stays, unless it was null.
     */
    set(l: PodLabel): PodLabel
    remove(captureId: string, slot: number): boolean
    /** By slot. */
    forCapture(captureId: string): PodLabel[]
    /** Labels whose capture time falls in [fromTs, toTs], oldest first, then by slot. */
    range(fromTs: string, toTs: string): PodLabel[]
    /** Newest capture first, then by pod; `before` continues after a page's last row. */
    list(q: { label?: PodLabelValue, camera?: 'upper' | 'lower', limit: number, before?: PodLabelCursor }): PodLabel[]
    /** How many pods carry each label. */
    counts(): Record<PodLabelValue, number>
    /** Labelled captures, newest first, with how many of their pods are labelled. */
    captures(limit?: number): Array<{ captureId: string, ts: string, camera: 'upper' | 'lower', pods: number }>
  }
  podCodes: {
    /** Owner-confirmed pairs, by code. */
    pairs(): PodCodePair[]
    pair(code: string): PodCodePair | null
    /** Upsert on code: a correction replaces the plant. */
    confirm(code: string, plant: string, ts: string): PodCodePair
    forget(code: string): boolean
    /** The latest read of every pod, by slot. */
    reads(): PodCodeRead[]
    /** Replace one camera's reads with a new pod-ID still's. */
    setReads(camera: 'upper' | 'lower', reads: PodCodeRead[]): void
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
  tankActions: {
    add(a: Omit<TankAction, 'id' | 'createdAt'>, createdAt: string): TankAction
    /** Newest first by when it was done. */
    list(q?: { kind?: TankActionKind, limit?: number }): TankAction[]
    remove(id: number): boolean
  }
  plans: {
    list(): PlanRow[]
    get(id: string): PlanRow | null
    save(p: Omit<PlanRow, 'createdAt' | 'updatedAt' | 'appliedAt' | 'issued'>): PlanRow
    remove(id: string): boolean
    markApplied(id: string, ts: string): PlanRow | null
    markIssued(id: string, key: string): void
  }
  close(): void
}

export interface Automation extends AutomationRule { createdAt: string, updatedAt: string }
export interface AutomationRun { id: number, automationId: number, firedAt: string, outcome: RunOutcome, detail: unknown }

export const DEFAULT_SETTINGS: Omit<DeviceSettings, 'updatedAt'> = {
  unitName: 'Gardyn',
  timezone: 'UTC',
  latitude: null,
  longitude: null,
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
  telemetryFlushMin: 5,
  primaryAnalyzer: 'green-threshold',
  analysisArtifacts: false,
  followGrowCycle: true,
  libraryLightsOff: null,
  analysisIngestToken: '',
  podRegions: null,
  mirrorEndpoint: null,
  mirrorBucket: null,
  mirrorRegion: 'auto',
  mirrorPrefix: '',
  mirrorAccessKeyId: null,
  mirrorSecretAccessKey: null,
  autopilotEnabled: true,
  homekitEnabled: false,
  setupComplete: false,
}
