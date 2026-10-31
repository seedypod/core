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

export const ButtonPress = z.enum(['single', 'double', 'long'])
export type ButtonPress = z.infer<typeof ButtonPress>

/** MQTT topic helpers. */
export const topics = {
  prefix: (unitId: string) => `seedypod/${unitId}`,
  availability: (u: string) => `${topics.prefix(u)}/availability`,
  system: (u: string) => `${topics.prefix(u)}/system`,
  sensor: (u: string, id: SensorId) => `${topics.prefix(u)}/sensor/${id}`,
  sensorCalibrate: (u: string, id: SensorId) => `${topics.prefix(u)}/sensor/${id}/calibrate`,
  sensorCalibration: (u: string, id: SensorId) => `${topics.prefix(u)}/sensor/${id}/calibration`,
  actuatorState: (u: string, id: ActuatorId) => `${topics.prefix(u)}/actuator/${id}/state`,
  actuatorSet: (u: string, id: ActuatorId) => `${topics.prefix(u)}/actuator/${id}/set`,
  button: (u: string) => `${topics.prefix(u)}/event/button`,
  alert: (u: string, kind: AlertKind) => `${topics.prefix(u)}/alert/${kind}`,
  alertAck: (u: string, kind: AlertKind) => `${topics.prefix(u)}/alert/${kind}/ack`,
} as const
