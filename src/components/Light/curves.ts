import { dayOn } from '@/src/lib/days'

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

/** Hours a day the curve has the light on at all, to the half hour. */
export function litHours(spec: { setpoints: Setpoint[] }): number {
  let lit = 0
  for (let m = 0; m < 1440; m++) if (levelAt(spec, m) > 0) lit++
  return Math.round(lit / 30) / 2
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
