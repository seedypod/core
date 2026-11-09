/**
 * Care engine (ADR-0029): runs the setup check when something that can change
 * it happens (a schedule, a pod, the sensor inventory, hald coming and going,
 * the tank level turning suspect) and on a slow tick, and keeps one alert per
 * problem. Event-driven so an agent watching alerts wakes only on a change.
 */
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { Store } from '../store/types'
import { SETUP_ALERTS, setupReport, type SetupReport } from './setup'

const TICK_MS = 15 * 60_000

export class CareEngine {
  private timer: ReturnType<typeof setInterval> | null = null
  private unsub: (() => void) | null = null
  private lastQuality: string | undefined
  /** When each kind's problem was last seen gone; a dismissal before that no longer holds. */
  private readonly resolvedAt = new Map<string, string>()

  constructor(private readonly deps: { store: Store, hal: HalClient, events: EventBus, now?: () => Date }) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /** Raise, refresh or clear each setup alert to match the unit. Writes only on a change. */
  tick(): SetupReport {
    const { store, hal, events } = this.deps
    const report = setupReport(store, hal.snapshot())
    const ts = this.now().toISOString()
    const rows = store.alerts.list()
    for (const kind of SETUP_ALERTS) {
      const issue = report.issues.find(i => i.alert === kind)
      const active = rows.find(a => a.kind === kind && a.active)
      if (!issue) {
        if (active) {
          store.alerts.clear(kind, ts)
          events.emit({ kind: 'mutation', path: `alerts.${kind}` })
        }
        this.resolvedAt.set(kind, ts)
        continue
      }
      if (active?.detail === issue.detail) continue
      // Dismissed stays dismissed until the problem changes or goes away and comes back.
      const last = rows.find(a => a.kind === kind)
      const resolved = this.resolvedAt.get(kind)
      if (!active && last?.dismissedAt && last.detail === issue.detail && (!resolved || resolved < last.dismissedAt)) continue
      store.alerts.raise(kind, issue.detail, ts)
      events.emit({ kind: 'mutation', path: `alerts.${kind}` })
    }
    return report
  }

  start(): void {
    this.stop()
    this.unsub = this.deps.events.subscribe((e) => {
      const relevant = (e.kind === 'schedule' && e.action === 'changed')
        || (e.kind === 'mutation' && (e.path === 'pods' || e.path === 'devices'))
        || (e.kind === 'hal' && (e.event.type === 'availability' || e.event.type === 'system' || e.event.type === 'devices'))
        // Turning suspect warns at once; turning good again clears on the tick, so a flapping sensor can't churn the card.
        || (e.kind === 'hal' && e.event.type === 'sensor' && e.event.id === 'water_level_pct' && e.event.reading.quality === 'suspect' && this.lastQuality !== 'suspect')
      if (e.kind === 'hal' && e.event.type === 'sensor' && e.event.id === 'water_level_pct') this.lastQuality = e.event.reading.quality
      if (relevant) this.safeTick()
    })
    this.safeTick()
    this.timer = setInterval(() => this.safeTick(), TICK_MS)
  }

  private safeTick(): void {
    try {
      this.tick()
    }
    catch (err) {
      console.warn(`care: ${(err as Error).message}`)
    }
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
