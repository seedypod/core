import { Activity, Droplets, FlaskConical, Gauge, Thermometer, Waves, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Reading, SensorId } from '@/src/hardware/contract'

export interface SensorMeta {
  label: string
  icon: LucideIcon
  /** Where the quantity belongs on screen. */
  group: 'water-quality' | 'water' | 'environment' | 'power'
}

/** Display metadata per contract quantity; values and units come from the reading itself. */
export const SENSOR_META: Record<SensorId, SensorMeta> = {
  air_temp: { label: 'Air', icon: Thermometer, group: 'environment' },
  humidity: { label: 'Humidity', icon: Droplets, group: 'environment' },
  pcb_temp: { label: 'Board', icon: Thermometer, group: 'environment' },
  water_distance: { label: 'Distance', icon: Droplets, group: 'water' },
  water_level_pct: { label: 'Tank', icon: Waves, group: 'water' },
  pump_v: { label: 'Pump voltage', icon: Zap, group: 'power' },
  pump_a: { label: 'Pump current', icon: Zap, group: 'power' },
  pump_w: { label: 'Pump power', icon: Zap, group: 'power' },
  ph: { label: 'pH', icon: FlaskConical, group: 'water-quality' },
  ec: { label: 'EC', icon: Activity, group: 'water-quality' },
  water_temp: { label: 'Water temp', icon: Gauge, group: 'water-quality' },
}

/** `6.1 pH`, `22.5°C`, `—` when there is no reading. pH is unitless by convention. */
export function formatReading(r: Pick<Reading, 'value' | 'unit'> | undefined): string {
  if (!r) return '—'
  if (r.unit === 'pH') return `${r.value}`
  return `${r.value}${r.unit.startsWith('°') ? r.unit : ` ${r.unit}`}`
}

export const hexAddr = (a: number | null): string => (a === null ? '—' : `0x${a.toString(16).toUpperCase().padStart(2, '0')}`)
