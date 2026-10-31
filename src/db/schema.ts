/**
 * seedypod.db — configuration and state. Telemetry is downsampled into the
 * same file (one unit, modest volume); split into a second DB like sleepypod's
 * biometrics.db only if it grows.
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const deviceSettings = sqliteTable('device_settings', {
  id: integer().primaryKey().default(1),
  unitName: text().notNull().default('Gardyn'),
  timezone: text().notNull().default('UTC'),
  temperatureUnit: text({ enum: ['C', 'F'] }).notNull().default('C'),
  /** Tank calibration: sensor→surface distance when full / empty (cm). */
  waterFullCm: real().notNull().default(5),
  waterEmptyCm: real().notNull().default(20),
  tankCapacityL: real().notNull().default(19),
  /** Reminders (days after cycle start; 0 disables). */
  thinningReminderDays: integer().notNull().default(14),
  rootCheckReminderDays: integer().notNull().default(21),
  harvestReminderDays: integer().notNull().default(35),
  nutrientReminderDays: integer().notNull().default(7),
  /** Optional API key for non-localhost REST/MCP (empty = off). */
  apiKey: text().notNull().default(''),
  /** Core-level MQTT bridge (ADR-0013); unset = dormant. */
  mqttUrl: text(),
  mqttUsername: text(),
  mqttPassword: text(),
  mqttTlsEnabled: integer({ mode: 'boolean' }).notNull().default(false),
  mqttTlsInsecure: integer({ mode: 'boolean' }).notNull().default(false),
  captureIntervalMin: integer().notNull().default(60),
  /** Analyser whose green fraction drives pod trends (ADR-0019). */
  primaryAnalyzer: text().notNull().default('green-threshold'),
  /** Store large analyser outputs (masks) in the blob sink. */
  analysisArtifacts: integer({ mode: 'boolean' }).notNull().default(false),
  /** Bearer token for POST /api/analyses/results; empty = ingest off. */
  analysisIngestToken: text().notNull().default(''),
  /** Opt-in S3-compatible mirror for stills and artifacts; unset = off. */
  mirrorEndpoint: text(),
  mirrorBucket: text(),
  mirrorRegion: text().notNull().default('auto'),
  mirrorPrefix: text().notNull().default(''),
  mirrorAccessKeyId: text(),
  mirrorSecretAccessKey: text(),
  /** Autopilot kill switch (ADR-0020): off stops every rule and drops their light leases. */
  autopilotEnabled: integer({ mode: 'boolean' }).notNull().default(true),
  updatedAt: text().notNull(),
})

export const schedules = sqliteTable('schedules', {
  id: text().primaryKey(),
  kind: text({ enum: ['light', 'pump'] }).notNull(),
  name: text().notNull(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  /** Bitmask Mon=1 … Sun=64; 127 = every day. */
  days: integer().notNull().default(127),
  /** JSON: light → {setpoints:[{minute, level}]}; pump → {minute, durationS, level?} */
  spec: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
})

export const scheduleRuns = sqliteTable('schedule_runs', {
  id: integer().primaryKey({ autoIncrement: true }),
  scheduleId: text().notNull(),
  /** Idempotency key: `${scheduleId}:${localDate}:${minute}` */
  key: text().notNull().unique(),
  firedAt: text().notNull(),
  result: text().notNull(),
})

export const alerts = sqliteTable('alerts', {
  id: integer().primaryKey({ autoIncrement: true }),
  /** HAL kinds (water_low, pump_fault, …) or core kinds (reminder_thinning, hal_offline, …). */
  kind: text().notNull(),
  active: integer({ mode: 'boolean' }).notNull().default(true),
  detail: text().notNull().default(''),
  raisedAt: text().notNull(),
  clearedAt: text(),
  acknowledgedAt: text(),
  dismissedAt: text(),
}, t => [index('alerts_kind_active').on(t.kind, t.active)])

export const growCycles = sqliteTable('grow_cycles', {
  id: text().primaryKey(),
  startedAt: text().notNull(),
  endedAt: text(),
  stage: text({ enum: ['germination', 'seedling', 'vegetative', 'harvest', 'ended'] }).notNull().default('germination'),
  notes: text().notNull().default(''),
  /** Reminders already issued for this cycle, JSON string[]. */
  issued: text().notNull().default('[]'),
})

export const pods = sqliteTable('pods', {
  slot: integer().primaryKey(),
  plant: text(),
  plantedAt: text(),
  status: text({ enum: ['empty', 'seeded', 'growing', 'harvest', 'attention'] }).notNull().default('empty'),
  notes: text().notNull().default(''),
  updatedAt: text().notNull(),
})

export const captures = sqliteTable('captures', {
  id: text().primaryKey(),
  camera: text({ enum: ['upper', 'lower'] }).notNull(),
  ts: text().notNull(),
  path: text().notNull(),
  bytes: integer().notNull(),
}, t => [index('captures_camera_ts').on(t.camera, t.ts)])

export const telemetry = sqliteTable('telemetry', {
  id: integer().primaryKey({ autoIncrement: true }),
  ts: text().notNull(),
  sensor: text().notNull(),
  value: real().notNull(),
}, t => [index('telemetry_sensor_ts').on(t.sensor, t.ts)])

export const counters = sqliteTable('counters', {
  key: text().primaryKey(),
  value: real().notNull().default(0),
  updatedAt: text().notNull(),
})

/** Hourly samples of the SD card's sectors-written counter (ADR-0021); `bytes` is the write since the previous sample. */
export const flashSamples = sqliteTable('flash_samples', {
  ts: text().primaryKey(),
  sectors: integer().notNull(),
  bytes: integer().notNull(),
})

/**
 * Capture analysis results (ADR-0019): one row per capture × analyser@version
 * × pod × metric, so analysers compare on shared captures and a re-run at a
 * new version sits beside the old rows instead of replacing them.
 */
export const analysisResults = sqliteTable('analysis_results', {
  id: integer().primaryKey({ autoIncrement: true }),
  captureId: text().notNull(),
  /** Capture timestamp, denormalised so series queries never join. */
  ts: text().notNull(),
  camera: text({ enum: ['upper', 'lower'] }).notNull(),
  analyzer: text().notNull(),
  version: integer().notNull(),
  source: text({ enum: ['device', 'remote'] }).notNull(),
  slot: integer().notNull(),
  metric: text().notNull(),
  value: real().notNull(),
  /** Small JSON; large outputs live in the blob sink under `artifact`. */
  detail: text(),
  artifact: text(),
}, t => [
  uniqueIndex('analysis_results_key').on(t.captureId, t.analyzer, t.version, t.slot, t.metric),
  index('analysis_results_series').on(t.analyzer, t.metric, t.slot, t.ts),
])

/** Autopilot rules (ADR-0020); the AST lives in JSON columns validated by zod at the API. */
export const automations = sqliteTable('automations', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  dryRun: integer({ mode: 'boolean' }).notNull().default(true),
  priority: integer().notNull().default(50),
  cooldownMin: integer(),
  trigger: text().notNull(),
  conditions: text().notNull(),
  actions: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
})

/** One row per evaluation where a rule's trigger was active: the audit log behind "why did it do that". */
export const automationRuns = sqliteTable('automation_runs', {
  id: integer().primaryKey({ autoIncrement: true }),
  automationId: integer().notNull(),
  firedAt: text().notNull(),
  outcome: text({ enum: ['fired', 'skipped', 'clamped', 'dry_run', 'refused', 'error'] }).notNull(),
  detail: text().notNull().default('{}'),
}, t => [index('automation_runs_rule_time').on(t.automationId, t.firedAt)])
