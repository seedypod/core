import { fmtClock } from '@/src/components/charts/format'
import { dayOn, weekdayOf } from '@/src/lib/days'

export interface PumpCycle { id: string, kind: 'pump', name: string, enabled: boolean, days: number, spec: { minute: number, durationS: number, level?: number } }

export function asCycle(s: { id: string, kind: string, name: string, enabled: boolean, days: number, spec: object }): PumpCycle | null {
  return s.kind === 'pump' && 'durationS' in s.spec ? { id: s.id, kind: 'pump', name: s.name, enabled: s.enabled, days: s.days, spec: s.spec as PumpCycle['spec'] } : null
}

/** When the cycle next fires after `now`, in local time; null when it has no days. */
export function nextFire(c: PumpCycle, now: Date): Date | null {
  for (let d = 0; d <= 7; d++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, Math.floor(c.spec.minute / 60), c.spec.minute % 60)
    if (dayOn(c.days, weekdayOf(at)) && at > now) return at
  }
  return null
}

/** The soonest enabled cycle. */
export function nextRun(cycles: PumpCycle[], now: Date): { at: Date, cycle: PumpCycle } | null {
  let best: { at: Date, cycle: PumpCycle } | null = null
  for (const cycle of cycles) {
    const at = cycle.enabled ? nextFire(cycle, now) : null
    if (at && (!best || at < best.at)) best = { at, cycle }
  }
  return best
}

/** "25 min", "8 h", "3 d". */
export function fmtSpan(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

/** A length of time as people say it: `45 s`, `15 min`, `2 min 30 s`, `1 h 5 min`. */
export function fmtMinutes(s: number): string {
  const secs = Math.max(0, Math.round(s))
  if (secs < 60) return `${secs} s`
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const rest = secs % 60
  if (h) return m ? `${h} h ${m} min` : `${h} h`
  return rest ? `${m} min ${rest} s` : `${m} min`
}

/** A countdown clock: `14:59`, `0:05`. */
export const fmtCountdown = (s: number): string => {
  const secs = Math.max(0, Math.ceil(s))
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** "Today 20:00", "Yesterday 14:12", else "Oct 29 08:00". */
export function fmtWhen(at: Date, now: Date): string {
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000)
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : at.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day} ${fmtClock(at.getHours() * 60 + at.getMinutes())}`
}

/** A cycle's status line: whichever is nearer, its last run or its next. */
export function cycleWhen(c: PumpCycle, lastRun: Date | null, now: Date): string {
  const next = c.enabled ? nextFire(c, now) : null
  const sinceLast = lastRun ? now.getTime() - lastRun.getTime() : Number.POSITIVE_INFINITY
  if (next && next.getTime() - now.getTime() <= sinceLast) return `next in ${fmtSpan(next.getTime() - now.getTime())}`
  if (lastRun) return `ran ${fmtSpan(sinceLast)} ago`
  return c.enabled ? 'never runs' : 'off'
}

/** Tank % at which the HAL refuses to start the pump, from the calibration; null when unknown. */
export function cutoffPct(waterLowCm: number | null | undefined, fullCm: number | undefined, emptyCm: number | undefined): number | null {
  if (waterLowCm == null || fullCm === undefined || emptyCm === undefined || emptyCm <= fullCm) return null
  return Math.round(Math.max(0, Math.min(100, ((emptyCm - waterLowCm) / (emptyCm - fullCm)) * 100)))
}

/** A rise this big between samples is a top-up, not sensor noise. */
const TOP_UP_PCT = 8

/** Where the tank was topped up, and how fast it drains between top-ups (% a day). Gaps (NaN) are skipped. */
export function tankTrend(xs: number[], values: number[]): { topUps: number[], dropPerDay: number | null } {
  const topUps: number[] = []
  let drop = 0
  let prev = -1
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number
    if (!Number.isFinite(v)) continue
    if (prev >= 0) {
      const d = v - (values[prev] as number)
      if (d >= TOP_UP_PCT) topUps.push(i)
      else if (d < 0) drop -= d
    }
    prev = i
  }
  const days = xs.length > 1 ? ((xs.at(-1) as number) - (xs[0] as number)) / 86_400_000 : 0
  return { topUps, dropPerDay: days > 0 ? Math.round(drop / days) : null }
}
