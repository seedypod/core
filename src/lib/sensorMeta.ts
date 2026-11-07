import { Activity, Droplets, FlaskConical, Gauge, Thermometer, Waves, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Reading, SensorId } from '@/src/hardware/contract'

export interface SensorMeta {
  label: string
  icon: LucideIcon
  /** Where the quantity belongs on screen. */
  group: 'water-quality' | 'water' | 'environment' | 'power'
  /** Line colour in charts. */
  color: string
}

/** Display metadata per contract quantity; values and units come from the reading itself. */
export const SENSOR_META: Record<SensorId, SensorMeta> = {
  air_temp: { label: 'Air', icon: Thermometer, group: 'environment', color: 'var(--chart-temp)' },
  humidity: { label: 'Humidity', icon: Droplets, group: 'environment', color: 'var(--chart-humidity)' },
  pcb_temp: { label: 'Board', icon: Thermometer, group: 'environment', color: 'var(--chart-3)' },
  water_distance: { label: 'Distance', icon: Droplets, group: 'water', color: 'var(--chart-water)' },
  water_level_pct: { label: 'Tank', icon: Waves, group: 'water', color: 'var(--chart-water)' },
  pump_v: { label: 'Pump voltage', icon: Zap, group: 'power', color: 'var(--chart-2)' },
  pump_a: { label: 'Pump current', icon: Zap, group: 'power', color: 'var(--chart-2)' },
  pump_w: { label: 'Pump power', icon: Zap, group: 'power', color: 'var(--status-ok)' },
  ph: { label: 'pH', icon: FlaskConical, group: 'water-quality', color: 'var(--chart-ph)' },
  ec: { label: 'EC', icon: Activity, group: 'water-quality', color: 'var(--chart-ec)' },
  water_temp: { label: 'Water temp', icon: Gauge, group: 'water-quality', color: 'var(--chart-temp)' },
}

/** A value and its unit: `22.5°C` and `53%` close up, `7 cm` and `3.1 W` spaced. */
export function withUnit(value: number | string, unit: string): string {
  if (!unit) return `${value}`
  return `${value}${unit.startsWith('°') || unit === '%' ? unit : ` ${unit}`}`
}

/** `6.1`, `22.5°C`, `53%`, `—` when there is no reading. pH is unitless by convention. */
export function formatReading(r: Pick<Reading, 'value' | 'unit'> | undefined): string {
  if (!r) return '—'
  if (r.unit === 'pH') return `${r.value}`
  return withUnit(r.value, r.unit)
}

export const hexAddr = (a: number | null): string => (a === null ? '—' : `0x${a.toString(16).toUpperCase().padStart(2, '0')}`)
