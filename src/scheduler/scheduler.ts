/**
 * Scheduler — evaluates light curves and pump cycles once a minute.
 *
 * Deliberately not cron: a light *curve* is a continuous function of local
 * time (interpolated setpoints, so sunrise/sunset ramps are free), and pump
 * runs are bounded events that must fire at most once per (schedule, day,
 * minute) even if the process restarts — the Store's run log is the
 * idempotency key. All inputs are injected so it is testable to the minute.
 */
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { LightSpec, PumpSpec, Schedule, Store } from '../store/types'
import { dayEnabled, localTime } from './time'

export interface SchedulerDeps {
  store: Store
  hal: HalClient
  events: EventBus
  now?: () => Date
  log?: (msg: string) => void
}

/** Desired light level at `minute` for a curve, or null if the curve is empty. */
export function lightLevelAt(spec: LightSpec, minute: number): number | null {
  const pts = [...spec.setpoints].sort((a, b) => a.minute - b.minute)
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!first || !last) return null
  if (pts.length === 1) return clamp(first.level)
  const m = ((minute % 1440) + 1440) % 1440
  // Wrap the curve around midnight: last point → first point of the next day.
  if (m < first.minute || m >= last.minute) {
    const span = first.minute + 1440 - last.minute
    const into = m >= last.minute ? m - last.minute : m + 1440 - last.minute
    return clamp(lerp(last.level, first.level, span === 0 ? 0 : into / span))
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (a && b && m >= a.minute && m < b.minute) {
      return clamp(lerp(a.level, b.level, (m - a.minute) / (b.minute - a.minute)))
    }
  }
  return clamp(last.level)
}

export interface TickResult {
  lightTarget: number | null
  pumpFired: string[]
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastLightApplied: number | null = null
  private readonly now: () => Date
  private readonly log: (msg: string) => void

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.log = deps.log ?? (() => undefined)
  }

  start(intervalMs = 60_000): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Evaluate every enabled schedule for "now". Safe to call repeatedly. */
  async tick(): Promise<TickResult> {
    const { store, hal } = this.deps
    const settings = store.settings.get()
    const now = this.now()
    const lt = localTime(now, settings.timezone)
    const schedules = store.schedules.list().filter(s => s.enabled && dayEnabled(s.days, lt.weekday))

    // Light: the highest active curve wins (lets a "boost" schedule overlay a base curve).
    let lightTarget: number | null = null
    for (const s of schedules.filter((s): s is Schedule & { spec: LightSpec } => s.kind === 'light')) {
      const lvl = lightLevelAt(s.spec, lt.minute)
      if (lvl !== null) lightTarget = lightTarget === null ? lvl : Math.max(lightTarget, lvl)
    }
    if (lightTarget !== null && lightTarget !== this.lastLightApplied) {
      try {
        await hal.setActuator('light', lightTarget === 0 ? { on: false, level: 0 } : { on: true, level: lightTarget })
        this.lastLightApplied = lightTarget
        this.deps.events.emit({ kind: 'schedule', action: 'fired', id: 'light-curve' })
      }
      catch (e) {
        this.log(`light curve apply failed: ${(e as Error).message}`)
      }
    }

    // Pump: fire once per schedule/day/minute.
    const pumpFired: string[] = []
    for (const s of schedules.filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')) {
      if (s.spec.minute !== lt.minute) continue
      const key = `${s.id}:${lt.date}:${lt.minute}`
      if (!store.schedules.recordRun({ scheduleId: s.id, key, firedAt: now.toISOString(), result: 'pending' })) continue
      try {
        await hal.setActuator('pump', { on: true, level: s.spec.level, durationS: s.spec.durationS })
        pumpFired.push(s.id)
        this.deps.events.emit({ kind: 'schedule', action: 'fired', id: s.id })
        this.log(`pump schedule ${s.name} fired for ${s.spec.durationS}s`)
      }
      catch (e) {
        // The HAL refused (dry tank, latched fault). The run stays recorded so
        // we don't hammer it every minute; the alert surfaces the reason.
        this.log(`pump schedule ${s.name} refused: ${(e as Error).message}`)
      }
    }
    return { lightTarget, pumpFired }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function clamp(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)))
}
