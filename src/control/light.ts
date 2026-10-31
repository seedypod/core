/**
 * The light's single owner (ADR-0020). Three sources want the light; the
 * highest one with an opinion wins:
 *
 *   1. manual — the app, REST, MCP, or anything outside core (the button, Home
 *      Assistant), held for `holdMs`;
 *   2. Autopilot — per-rule leases, highest priority then most recent;
 *   3. schedule — the light curve's current point.
 *
 * The arbiter writes only when the resolved level changes. The schedule's
 * clock keeps running underneath, so when a hold ends the light lands on the
 * current curve point instead of replaying an old one.
 */
import type { ActuatorState } from '../hardware/contract'
import type { HalClient } from '../hardware/types'

export interface LightLease {
  /** `rule:<id>:<action index>` */
  id: string
  level: number
  priority: number
  /** Epoch ms. */
  expiresAt: number
  createdAt: number
}

export type LightSource = 'manual' | 'autopilot' | 'schedule' | null

export interface LightStatus {
  source: LightSource
  level: number | null
  /** The winning Autopilot lease, when Autopilot is in charge. */
  leaseId: string | null
  manualUntil: string | null
  schedule: number | null
}

export interface LightArbiterOptions {
  hal: HalClient
  now?: () => number
  /** How long a manual change holds. */
  holdMs?: number
  log?: (msg: string) => void
}

export const MANUAL_HOLD_MS = 30 * 60_000

const levelOf = (s: ActuatorState) => (s.on ? s.level : 0)

export class LightArbiter {
  private readonly now: () => number
  private readonly holdMs: number
  private manual: { level: number, until: number } | null = null
  private leases = new Map<string, LightLease>()
  private schedule: number | null = null
  /** What the arbiter last commanded, to tell its own echoes from outside changes. */
  private lastWritten: number | null = null
  private writing: number | null = null
  private chain: Promise<void> = Promise.resolve()
  private readonly unsubscribe: () => void

  constructor(private readonly o: LightArbiterOptions) {
    this.now = o.now ?? Date.now
    this.holdMs = o.holdMs ?? MANUAL_HOLD_MS
    this.unsubscribe = o.hal.subscribe((e) => {
      if (e.type === 'actuator' && e.id === 'light') this.observe(e.state)
    })
  }

  close(): void {
    this.unsubscribe()
  }

  /** A person set the light: apply it now and hold it. Resolves with hald's state. */
  async setManual(level: number): Promise<ActuatorState> {
    this.manual = { level, until: this.now() + this.holdMs }
    return this.write(level)
  }

  /** Release a manual hold early and fall back to Autopilot or the schedule. */
  resume(): Promise<void> {
    this.manual = null
    return this.apply()
  }

  /** The scheduler's current curve point (null when no curve covers now). */
  setSchedule(level: number | null): Promise<void> {
    this.schedule = level
    return this.apply()
  }

  /** Replace every Autopilot lease at once (the engine publishes its full set each tick). */
  setLeases(leases: LightLease[]): Promise<void> {
    this.leases = new Map(leases.map(l => [l.id, l]))
    return this.apply()
  }

  status(): LightStatus {
    const r = this.resolve()
    return { source: r.source, level: r.level, leaseId: r.leaseId, manualUntil: this.manual ? new Date(this.manual.until).toISOString() : null, schedule: this.schedule }
  }

  /** Resolves when every queued write has settled. */
  idle(): Promise<void> {
    return this.chain
  }

  private resolve(): { source: LightSource, level: number | null, leaseId: string | null } {
    const now = this.now()
    if (this.manual && this.manual.until <= now) this.manual = null
    if (this.manual) return { source: 'manual', level: this.manual.level, leaseId: null }
    const live = [...this.leases.values()].filter(l => l.expiresAt > now)
      .sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt)
    const top = live[0]
    if (top) return { source: 'autopilot', level: top.level, leaseId: top.id }
    if (this.schedule !== null) return { source: 'schedule', level: this.schedule, leaseId: null }
    return { source: null, level: null, leaseId: null }
  }

  private apply(): Promise<void> {
    const { level } = this.resolve()
    if (level === null || level === this.lastWritten || level === this.writing) return this.chain
    return this.write(level).then(() => undefined, (e: Error) => this.o.log?.(`light: ${e.message}`))
  }

  private write(level: number): Promise<ActuatorState> {
    const run = this.chain.then(async () => {
      this.writing = level
      try {
        const state = await this.o.hal.setActuator('light', level === 0 ? { on: false, level: 0 } : { on: true, level })
        this.lastWritten = levelOf(state)
        return state
      }
      finally {
        this.writing = null
      }
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** A light state we didn't command came from outside core: treat it as manual. */
  private observe(state: ActuatorState): void {
    const level = levelOf(state)
    if (this.writing !== null && Math.abs(level - this.writing) < 0.5) return
    if (this.lastWritten !== null && Math.abs(level - this.lastWritten) < 0.5) return
    if (this.lastWritten === null && this.writing === null) {
      // First state we see (boot, reconnect): adopt it without calling it manual.
      this.lastWritten = level
      return
    }
    this.lastWritten = level
    this.manual = { level, until: this.now() + this.holdMs }
  }
}
