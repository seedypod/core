/**
 * Care engine (ADR-0029): runs the grow protocol (ADR-0030), the setup check
 * and the chores when something that can change them happens (a schedule, a
 * pod, the grow cycle, the sensor inventory, hald coming and going, the tank
 * level turning suspect, a logged tank action, a new capture) and on a slow
 * tick, and keeps one alert per problem. A chore raises an alert only when a
 * reading makes it due: calendar chores are the grow reminders' job, and a
 * reading is news. Event-driven so an agent watching
 * alerts wakes only on a change.
 */
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { Store, TankActionKind } from '../store/types'
import { chores, type Chore, type ChoreId } from './chores'
import { FOLLOW_ALERT, type FollowChange } from './follow'
import { runProtocol } from './protocol'
import { SETUP_ALERTS, setupReport, type SetupReport } from './setup'

const TICK_MS = 15 * 60_000

/** The chores a reading can make due, and the alert each raises. */
export const CHORE_ALERTS = { top_off: 'chore_top_off', feed: 'chore_feed', thin: 'chore_thin' } as const satisfies Partial<Record<ChoreId, string>>

/** The tank action that marks a chore alert's chore done, for acknowledging it. */
export function choreDoneKind(alert: string): TankActionKind | null {
  const id = (Object.keys(CHORE_ALERTS) as Array<keyof typeof CHORE_ALERTS>).find(k => CHORE_ALERTS[k] === alert)
  return id ?? null
}

export class CareEngine {
  private timer: ReturnType<typeof setInterval> | null = null
  private unsub: (() => void) | null = null
  private lastQuality: string | undefined
  /** A tick is running, and whether something asked for another while it did. */
  private ticking = false
  private again = false
  /** When each kind's problem was last seen gone; a dismissal before that no longer holds. */
  private readonly resolvedAt = new Map<string, string>()

  constructor(private readonly deps: { store: Store, hal: HalClient, events: EventBus, now?: () => Date }) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /** Run the grow protocol (ADR-0030), then raise, refresh or clear each setup and chore alert to match the unit. Writes only on a change. */
  tick(): { setup: SetupReport, chores: Chore[], followed: FollowChange | null } {
    const { store, hal, events } = this.deps
    const snap = hal.snapshot()
    const now = this.now()
    const { followed, notices } = runProtocol(store, now)
    if (followed) {
      store.alerts.raise(FOLLOW_ALERT, followed.detail, now.toISOString())
      events.emit({ kind: 'schedule', action: 'changed', id: `follow:${followed.to}` })
      events.emit({ kind: 'mutation', path: `alerts.${FOLLOW_ALERT}` })
    }
    for (const n of notices) {
      store.alerts.raise(n.kind, n.detail, now.toISOString())
      events.emit({ kind: 'mutation', path: `alerts.${n.kind}` })
    }
    const setup = setupReport(store, snap)
    const list = chores(store, snap, now)
    const rows = store.alerts.list()
    for (const kind of SETUP_ALERTS) this.sync(rows, kind, setup.issues.find(i => i.alert === kind)?.detail ?? null, false)
    for (const [id, kind] of Object.entries(CHORE_ALERTS)) {
      const c = list.find(x => x.id === id)
      // A chore's detail carries the reading, so it changes every sample: held in memory, and dismissal goes by kind.
      this.sync(rows, kind, c?.state === 'due' && c.basis === 'reading' ? c.reason : null, true)
    }
    return { setup, chores: list, followed }
  }

  private sync(rows: ReturnType<Store['alerts']['list']>, kind: string, detail: string | null, live: boolean): void {
    const { store, events } = this.deps
    const ts = this.now().toISOString()
    const active = rows.find(a => a.kind === kind && a.active)
    if (detail === null) {
      if (active) {
        store.alerts.clear(kind, ts)
        events.emit({ kind: 'mutation', path: `alerts.${kind}` })
      }
      this.resolvedAt.set(kind, ts)
      return
    }
    if (active?.detail === detail) return
    if (!active) {
      // Dismissed stays dismissed until the problem changes (setup) or goes away and comes back.
      const last = rows.find(a => a.kind === kind)
      const resolved = this.resolvedAt.get(kind)
      if (last?.dismissedAt && (live || last.detail === detail) && (!resolved || resolved < last.dismissedAt)) return
    }
    store.alerts.raise(kind, detail, ts, { live: live && !!active })
    if (!active || !live) events.emit({ kind: 'mutation', path: `alerts.${kind}` })
  }

  start(): void {
    this.stop()
    this.unsub = this.deps.events.subscribe((e) => {
      const relevant = (e.kind === 'schedule' && e.action === 'changed')
        || (e.kind === 'mutation' && (e.path === 'pods' || e.path === 'grow' || e.path === 'devices' || e.path === 'tank' || e.path === 'captures'))
        || (e.kind === 'hal' && (e.event.type === 'availability' || e.event.type === 'system' || e.event.type === 'devices'))
        // Turning suspect warns at once; turning good again clears on the tick, so a flapping sensor can't churn the card.
        || (e.kind === 'hal' && e.event.type === 'sensor' && e.event.id === 'water_level_pct' && e.event.reading.quality === 'suspect' && this.lastQuality !== 'suspect')
      if (e.kind === 'hal' && e.event.type === 'sensor' && e.event.id === 'water_level_pct') this.lastQuality = e.event.reading.quality
      if (relevant) this.safeTick()
    })
    this.safeTick()
    this.timer = setInterval(() => this.safeTick(), TICK_MS)
  }

  /**
   * One tick at a time: a tick that moves the watering announces the schedule
   * change, which this engine listens for, so that asks for one more tick
   * after this one rather than one nested inside it.
   */
  private safeTick(): void {
    if (this.ticking) {
      this.again = true
      return
    }
    this.ticking = true
    try {
      do {
        this.again = false
        try {
          this.tick()
        }
        catch (err) {
          console.warn(`care: ${(err as Error).message}`)
        }
      } while (this.again)
    }
    finally {
      this.ticking = false
    }
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
