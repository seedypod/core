/**
 * HAL contract v1 — the wire schema between `hald` (hal/) and core.
 * Keep in sync with hal/contract/v1.schema.json (ADR-0007).
 */
import { z } from 'zod'

export const CONTRACT_VERSION = 1 as const

export const SensorId = z.enum([
  'air_temp',
  'humidity',
  'pcb_temp',
  'water_distance',
  'water_level_pct',
  'pump_v',
  'pump_a',
  'pump_w',
  'ph',
  'ec',
  'water_temp',
])
export type SensorId = z.infer<typeof SensorId>

export const ActuatorId = z.enum(['light', 'pump', 'dose_1', 'dose_2', 'dose_3'])
export type ActuatorId = z.infer<typeof ActuatorId>

export const AlertKind = z.enum(['water_low', 'pump_fault', 'dose_fault', 'over_temp', 'camera_missing', 'hal_offline'])
export type AlertKind = z.infer<typeof AlertKind>

export const Quality = z.enum(['good', 'stale', 'suspect'])

export const Reading = z.object({
  ts: z.string().datetime({ offset: true }),
  value: z.number(),
  unit: z.string(),
  quality: Quality.default('good'),
})
export type Reading = z.infer<typeof Reading>

export const ActuatorState = z.object({
  on: z.boolean(),
  /** 0–100 */
  level: z.number().min(0).max(100),
  since: z.string().datetime({ offset: true }),
  /** Latched fault; cleared only by an explicit acknowledge. */
  fault: z.string().nullable().default(null),
  /** Remaining seconds on a bounded run, if any. */
  remainingS: z.number().int().nonnegative().nullable().default(null),
})
export type ActuatorState = z.infer<typeof ActuatorState>

export const ActuatorCommand = z.object({
  on: z.boolean().optional(),
  level: z.number().min(0).max(100).optional(),
  /** Bounded run; the HAL clamps to its own max and turns the actuator off after. */
  durationS: z.number().int().positive().optional(),
})
export type ActuatorCommand = z.infer<typeof ActuatorCommand>

export const Limits = z.object({
  pumpMaxRunS: z.number().int().positive(),
  pumpMaxDuty: z.number().min(0).max(100),
  waterLowCm: z.number().nullable(),
})
export type Limits = z.infer<typeof Limits>

export const SystemInfo = z.object({
  contract: z.literal(CONTRACT_VERSION),
  unitId: z.string(),
  model: z.string(),
  /** The Raspberry Pi hald runs on ("Raspberry Pi Zero 2 W Rev 1.0"); absent in the simulator and from older hald. */
  board: z.string().optional(),
  halVersion: z.string(),
  caps: z.object({
    sensors: z.array(SensorId),
    actuators: z.array(ActuatorId),
    cameras: z.array(z.enum(['upper', 'lower'])),
  }),
  limits: Limits,
})
export type SystemInfo = z.infer<typeof SystemInfo>

export const Alert = z.object({
  kind: AlertKind,
  active: z.boolean(),
  ts: z.string().datetime({ offset: true }),
  detail: z.string().default(''),
})
export type Alert = z.infer<typeof Alert>

/**
 * Probe calibration (EZO naming): pH `mid` first, then `low`/`high`; EC `dry`
 * then `single` or `low`+`high`; RTD `single`. `clear` wipes stored points.
 */
export const CalibrationPoint = z.enum(['mid', 'low', 'high', 'dry', 'single', 'clear'])
export type CalibrationPoint = z.infer<typeof CalibrationPoint>

/** `sensor/<id>/calibrate`. `value` is the reference in the sensor's reported unit (pH, mS/cm, °C). */
export const CalibrationCommand = z.object({
  point: CalibrationPoint,
  value: z.number().finite().optional(),
})
export type CalibrationCommand = z.infer<typeof CalibrationCommand>

/** `sensor/<id>/calibration` (retained): outcome of the last calibrate command. */
export const CalibrationResult = z.object({
  ts: z.string().datetime({ offset: true }),
  point: CalibrationPoint,
  ok: z.boolean(),
  points: z.number().int().nonnegative().nullable(),
  detail: z.string().default(''),
})
export type CalibrationResult = z.infer<typeof CalibrationResult>

/** One step of a probe's calibration procedure, rendered by the app's wizard. */
export const CalibrationStep = z.object({
  point: CalibrationPoint,
  label: z.string(),
  instruction: z.string(),
  /** Reference value to suggest (pH, mS/cm, °C); null for `dry`/`clear`. */
  defaultValue: z.number().nullable(),
  optional: z.boolean(),
})
export type CalibrationStep = z.infer<typeof CalibrationStep>

/** A sensor kind hald can add at runtime — the serialised `SensorKind` descriptor. */
export const DeviceKindInfo = z.object({
  kind: z.string(),
  label: z.string(),
  description: z.string(),
  ids: z.array(SensorId),
  bus: z.string(),
  defaultAddr: z.number().int().nullable(),
  calibration: z.array(CalibrationStep),
})
export type DeviceKindInfo = z.infer<typeof DeviceKindInfo>

export const DeviceEntry = z.object({
  kind: z.string(),
  label: z.string(),
  addr: z.number().int().nullable(),
  ids: z.array(SensorId),
  /** `config` = hal.toml (not removable from the app); `user` = added from the app. */
  source: z.enum(['config', 'user']),
  status: z.enum(['ready', 'absent']),
  detail: z.string(),
})
export type DeviceEntry = z.infer<typeof DeviceEntry>

/** `devices` (retained): configured sensor devices and what can be added. */
export const DeviceInventory = z.object({
  sensors: z.array(DeviceEntry),
  addable: z.array(DeviceKindInfo),
})
export type DeviceInventory = z.infer<typeof DeviceInventory>

/** `devices/set`. */
export const DeviceCommand = z.object({
  requestId: z.string(),
  op: z.enum(['add', 'remove']),
  kind: z.string(),
  addr: z.number().int().min(0).max(0x7f),
})
export type DeviceCommand = z.infer<typeof DeviceCommand>

/** `devices/result`, matched by `requestId`. */
export const DeviceResult = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  detail: z.string(),
})
export type DeviceResult = z.infer<typeof DeviceResult>

export const ButtonPress = z.enum(['single', 'double', 'long', 'setup'])
export const ButtonEvent = z.object({ press: ButtonPress })
export type ButtonPress = z.infer<typeof ButtonPress>

/** MQTT topic helpers. */
export const topics = {
  prefix: (unitId: string) => `seedypod/${unitId}`,
  availability: (u: string) => `${topics.prefix(u)}/availability`,
  system: (u: string) => `${topics.prefix(u)}/system`,
  sensor: (u: string, id: SensorId) => `${topics.prefix(u)}/sensor/${id}`,
  sensorCalibrate: (u: string, id: SensorId) => `${topics.prefix(u)}/sensor/${id}/calibrate`,
  sensorCalibration: (u: string, id: SensorId) => `${topics.prefix(u)}/sensor/${id}/calibration`,
  devices: (u: string) => `${topics.prefix(u)}/devices`,
  devicesSet: (u: string) => `${topics.prefix(u)}/devices/set`,
  devicesResult: (u: string) => `${topics.prefix(u)}/devices/result`,
  actuatorState: (u: string, id: ActuatorId) => `${topics.prefix(u)}/actuator/${id}/state`,
  actuatorSet: (u: string, id: ActuatorId) => `${topics.prefix(u)}/actuator/${id}/set`,
  button: (u: string) => `${topics.prefix(u)}/event/button`,
  alert: (u: string, kind: AlertKind) => `${topics.prefix(u)}/alert/${kind}`,
  alertAck: (u: string, kind: AlertKind) => `${topics.prefix(u)}/alert/${kind}/ack`,
} as const
