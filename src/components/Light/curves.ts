import { dayOn } from '@/src/lib/days'
import { lightDay, type LightDay } from '@/src/scheduler/lightPlan'
import { localTime, systemZone } from '@/src/scheduler/time'

export interface Setpoint { minute: number, level: number }
export interface LightCurve { id: string, kind: 'light', name: string, enabled: boolean, days: number, spec: { setpoints: Setpoint[] } }

/** One sample every 15 minutes, midnight to midnight. */
export const SAMPLE_MINUTES = Array.from({ length: 97 }, (_, i) => i * 15)

/** Client-side copy of the scheduler's interpolation for instant previews. */
export function levelAt(spec: { setpoints: Setpoint[] }, minute: number): number {
  const pts = [...spec.setpoints].sort((a, b) => a.minute - b.minute)
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!first || !last) return 0
  if (pts.length === 1) return first.level
  const m = minute % 1440
  if (m < first.minute || m >= last.minute) {
    const span = first.minute + 1440 - last.minute
    const into = m >= last.minute ? m - last.minute : m + 1440 - last.minute
    return Math.round(last.level + (first.level - last.level) * (span === 0 ? 0 : into / span))
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (a && b && m >= a.minute && m < b.minute) return Math.round(a.level + (b.level - a.level) * ((m - a.minute) / (b.minute - a.minute)))
  }
  return last.level
}

/** The curves that run today: enabled, and today is one of their days. */
export function runningToday(curves: LightCurve[], weekday: number): LightCurve[] {
  return curves.filter(c => c.enabled && dayOn(c.days, weekday))
}

/** Today's target through the day; the highest curve wins, as in the scheduler. */
export function todayLevels(curves: LightCurve[]): number[] | null {
  if (curves.length === 0) return null
  return SAMPLE_MINUTES.map(m => Math.max(...curves.map(c => levelAt(c.spec, m))))
}

export function asCurve(s: { id: string, kind: string, name: string, enabled: boolean, days: number, spec: object }): LightCurve | null {
  return s.kind === 'light' && 'setpoints' in s.spec ? { id: s.id, kind: 'light', name: s.name, enabled: s.enabled, days: s.days, spec: s.spec as LightCurve['spec'] } : null
}

/** The highest level of `curves` at a minute of the day, as the scheduler picks; 0 with none. */
export const mergedAt = (curves: LightCurve[], minute: number) => Math.max(0, ...curves.map(c => levelAt(c.spec, minute)))

/** Today's light from the running curves, as the scheduler merges them. */
export const lightToday = (curves: LightCurve[]): LightDay => lightDay(m => mergedAt(curves, m))

/** When the light next comes on after `nowMin` and which curve brings it: today's curves, then tomorrow's. */
export function nextOn(today: LightCurve[], tomorrow: LightCurve[], nowMin: number): { minute: number, name: string, tomorrow: boolean } | null {
  const find = (curves: LightCurve[], from: number) => {
    for (let m = from; m < 1440; m++) {
      if (mergedAt(curves, m) > 0 && mergedAt(curves, (m + 1439) % 1440) === 0) {
        const by = curves.reduce((a, c) => (levelAt(c.spec, m) > levelAt(a.spec, m) ? c : a))
        return { minute: m, name: by.name }
      }
    }
    return null
  }
  const later = today.length ? find(today, Math.floor(nowMin) + 1) : null
  if (later) return { ...later, tomorrow: false }
  const first = tomorrow.length ? find(tomorrow, 0) : null
  return first && { ...first, tomorrow: true }
}

/** When the running curves next take the light below its level now, or null if they don't today. */
export function nextDim(curves: LightCurve[], nowMin: number): number | null {
  const start = Math.floor(nowMin)
  const level = mergedAt(curves, start)
  if (level === 0) return null
  for (let m = start + 1; m < 1440; m++) if (mergedAt(curves, m) < level) return m
  return null
}

/** A manual hold's window today in minutes of the unit's day: from when the light was set (or midnight) until it hands back (or midnight). */
export function holdWindow(sinceIso: string, untilIso: string, now: Date, timezone = systemZone()): { fromMin: number, untilMin: number } {
  const nowMin = localTime(now, timezone).minute + (now.getTime() % 60_000) / 60_000
  const minutes = (iso: string) => Math.max(0, Math.min(1440, nowMin + (Date.parse(iso) - now.getTime()) / 60_000))
  return { fromMin: minutes(sinceIso), untilMin: minutes(untilIso) }
}
