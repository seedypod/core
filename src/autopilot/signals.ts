/**
 * The signals rules can read (ADR-0020): a typed catalog for the builder and a
 * live snapshot for the engine. Every key is numeric; a signal with no current
 * value is absent from the snapshot, which rules read as "unknown".
 */
import { cycleDay } from '../grow/grow'
import { ActuatorId, SensorId } from '../hardware/contract'
import type { HalSnapshot } from '../hardware/types'
import type { Store } from '../store/types'

export interface SignalInfo {
  key: string
  label: string
  unit: string
  group: 'sensors' | 'actuators' | 'alerts' | 'pods' | 'grow'
  /** Not recorded historically, so a backtest reads it as unknown. */
  liveOnly: boolean
}

const SENSOR_LABELS: Record<SensorId, [string, string]> = {
  air_temp: ['Air temperature', '°C'],
  humidity: ['Humidity', '%'],
  pcb_temp: ['Board temperature', '°C'],
  water_distance: ['Water distance', 'cm'],
  water_level_pct: ['Tank level', '%'],
  pump_v: ['Pump voltage', 'V'],
  pump_a: ['Pump current', 'A'],
  pump_w: ['Pump power', 'W'],
  ph: ['pH', 'pH'],
  ec: ['EC', 'mS/cm'],
  water_temp: ['Water temperature', '°C'],
}

const ALERT_KINDS = ['water_low', 'pump_fault', 'dose_fault', 'over_temp', 'camera_missing', 'hal_offline', 'light_fault', 'mirror_failed'] as const
export const POD_SLOTS = 30
/** Points in the pod trend slope: about 12 hours of hourly stills. */
const TREND_POINTS = 12

export function catalog(): SignalInfo[] {
  const out: SignalInfo[] = SensorId.options.map(id => ({ key: `sensor.${id}`, label: SENSOR_LABELS[id][0], unit: SENSOR_LABELS[id][1], group: 'sensors', liveOnly: false }))
  out.push({ key: 'light.level', label: 'Light level', unit: '%', group: 'actuators', liveOnly: true })
  for (const id of ActuatorId.options.filter(a => a !== 'light')) {
    out.push({ key: `${id}.on`, label: `${actuatorLabel(id)} running`, unit: '1/0', group: 'actuators', liveOnly: true })
  }
  out.push({ key: 'pump.level', label: 'Pump duty', unit: '%', group: 'actuators', liveOnly: true })
  for (const kind of ALERT_KINDS) out.push({ key: `alert.${kind}`, label: `Alert: ${kind.replace(/_/g, ' ')}`, unit: '1/0', group: 'alerts', liveOnly: false })
  for (let slot = 1; slot <= POD_SLOTS; slot++) {
    out.push({ key: `pod.${slot}.green`, label: `Pod ${slot} green area`, unit: '0–1', group: 'pods', liveOnly: false })
    out.push({ key: `pod.${slot}.trend`, label: `Pod ${slot} growth trend`, unit: 'per capture', group: 'pods', liveOnly: false })
  }
  out.push({ key: 'grow.day', label: 'Grow-cycle day', unit: 'days', group: 'grow', liveOnly: false })
  return out
}

function actuatorLabel(id: string): string {
  return id === 'pump' ? 'Pump' : `Doser ${id.slice(-1)}`
}

/** Least-squares slope of a series against its index. */
export function slope(values: number[]): number | undefined {
  const n = values.length
  if (n < 3) return undefined
  const mx = (n - 1) / 2
  const my = values.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  values.forEach((v, i) => {
    num += (i - mx) * (v - my)
    den += (i - mx) ** 2
  })
  return Math.round((num / den) * 10_000) / 10_000
}

export function podSignals(store: Store, slots: number[] = Array.from({ length: POD_SLOTS }, (_, i) => i + 1)): Record<string, number> {
  const analyzer = store.settings.get().primaryAnalyzer
  const out: Record<string, number> = {}
  for (const slot of slots) {
    const series = store.analyses.series({ analyzer, slot, metric: 'green_fraction', limit: TREND_POINTS }).map(p => p.value)
    const last = series.at(-1)
    if (last !== undefined) out[`pod.${slot}.green`] = last
    const t = slope(series)
    if (t !== undefined) out[`pod.${slot}.trend`] = t
  }
  return out
}

/** Every signal's current value. Pods are only read for the slots a rule references. */
export function liveSignals(hal: HalSnapshot, store: Store, now: Date, podSlots: number[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, r] of Object.entries(hal.sensors)) {
    // A stale reading is no reading: rules must not act on it.
    if (r && r.quality !== 'stale') out[`sensor.${id}`] = r.value
  }
  for (const [id, s] of Object.entries(hal.actuators)) {
    if (!s) continue
    if (id === 'light') out['light.level'] = s.on ? s.level : 0
    else out[`${id}.on`] = s.on ? 1 : 0
    if (id === 'pump') out['pump.level'] = s.level
  }
  const active = new Set(store.alerts.list({ activeOnly: true }).map(a => a.kind))
  for (const kind of ALERT_KINDS) out[`alert.${kind}`] = active.has(kind) ? 1 : 0
  Object.assign(out, podSignals(store, podSlots))
  const cycle = store.grow.current()
  if (cycle) out['grow.day'] = cycleDay(cycle, now)
  return out
}

/** Pod slots referenced by a set of signal keys. */
export function podSlotsIn(keys: Iterable<string>): number[] {
  const slots = new Set<number>()
  for (const k of keys) {
    const m = /^pod\.(\d+)\./.exec(k)
    if (m) slots.add(Number(m[1]))
  }
  return [...slots]
}
