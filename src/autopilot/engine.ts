/**
 * Autopilot engine (ADR-0020): evaluates WHEN/IF/THEN rules on a 60 s tick.
 * Trigger handling, three-valued conditions, windows, cooldowns, the runaway
 * guard and the kill switch follow sleepypod's `src/automation/engine.ts`;
 * the actions are seedypod's and go through the light arbiter or hald, whose
 * guards still bound them. Every evaluation where a trigger was active writes
 * one audit row.
 *
 * Fully injected, so it tests without hardware, a database or timers.
 */
import type { LightLease } from '../control/light'
import { maxWindowMin, signalsOf, windowedSignals } from './ast'
import { evaluateCondition } from './evaluator'
import { clamp, evaluateExpr, SustainTracker, type EvalContext } from './expressions'
import { podSlotsIn } from './signals'
import {
  AUTOPILOT_DEFAULT_HOLD_MIN,
  AUTOPILOT_LIGHT_ANTI_THRASH,
  AUTOPILOT_MAX_ACTIONS_PER_HOUR,
  AUTOPILOT_TICK_MS,
  TIME_OF_DAY_GRACE_MIN,
  type Action,
  type AutomationRule,
  type DayOfWeek,
  type DoserId,
  type PodStatus,
  type RunOutcome,
} from './types'
import { WindowStore } from './windows'

/** Thrown by an action when hald (or the store) refuses it; logged as `refused`, never retried. */
export class ActionRefused extends Error {}

export interface AutopilotActions {
  notify(rule: AutomationRule, message: string): void
  /** Clear a rule's notification once its condition no longer holds. */
  clearNotice(rule: AutomationRule): void
  setLightLeases(leases: LightLease[]): Promise<void>
  runPump(durationS: number, level?: number): Promise<void>
  stopPump(): Promise<void>
  dose(doser: DoserId, durationS: number): Promise<void>
  setPodStatus(slot: number, status: PodStatus): void
}

export interface AutopilotDeps {
  now: () => number
  clock: () => { nowMinutes: number, dayOfWeek: DayOfWeek, dateKey: string }
  signals: (podSlots: number[]) => Record<string, number>
  loadRules: () => AutomationRule[]
  recordRun: (automationId: number, outcome: RunOutcome, detail: unknown) => void
  disableRule: (automationId: number) => void
  /** The persisted kill switch. */
  enabled: () => boolean
  act: AutopilotActions
  /** Called after a tick that recorded anything, for live UI refresh. */
  changed?: () => void
  log?: (msg: string) => void
}

interface Runtime {
  fingerprint: string
  lastFiredMs: number | null
  actionTimes: number[]
  lastTriggerValue?: number
  lastTriggerSeen: boolean
  lastTickEvalMs: number
  lastTimeKey?: string
  /** The last condition result, for the status view. */
  condition: boolean | undefined
}

export interface ActionResult {
  kind: Action['kind']
  raw?: number
  value?: number
  clamped?: boolean
  dryRun?: boolean
  sent?: boolean
  antiThrash?: boolean
  skipped?: string
  refused?: string
  error?: string
}

export interface RuleStatus {
  id: number
  condition: boolean | null
  lastFiredAt: string | null
  actionsLastHour: number
  cooldownUntil: string | null
}

type Lease = LightLease & { ruleId: number, policy: boolean }

export class AutopilotEngine {
  private readonly windows = new WindowStore()
  private readonly sustain = new SustainTracker()
  private readonly runtime = new Map<number, Runtime>()
  private leases = new Map<string, Lease>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private wasEnabled = true
  private lastTickMs: number | null = null

  constructor(private readonly d: AutopilotDeps) {}

  start(intervalMs = AUTOPILOT_TICK_MS): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status(): { enabled: boolean, lastTickAt: string | null, leases: Array<{ id: string, level: number, expiresAt: string }>, rules: RuleStatus[] } {
    const now = this.d.now()
    return {
      enabled: this.d.enabled(),
      lastTickAt: this.lastTickMs === null ? null : new Date(this.lastTickMs).toISOString(),
      leases: [...this.leases.values()].map(l => ({ id: l.id, level: l.level, expiresAt: new Date(l.expiresAt).toISOString() })),
      rules: [...this.runtime.entries()].map(([id, rt]) => {
        const rule = this.d.loadRules().find(r => r.id === id)
        const cooldownEnd = rule?.cooldownMin && rt.lastFiredMs !== null ? rt.lastFiredMs + rule.cooldownMin * 60_000 : null
        return {
          id,
          condition: rt.condition ?? null,
          lastFiredAt: rt.lastFiredMs === null ? null : new Date(rt.lastFiredMs).toISOString(),
          actionsLastHour: rt.actionTimes.filter(t => now - t < 3_600_000).length,
          cooldownUntil: cooldownEnd && cooldownEnd > now ? new Date(cooldownEnd).toISOString() : null,
        }
      }),
    }
  }

  /** One evaluation pass over every enabled rule. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    let recorded = false
    try {
      const now = this.d.now()
      this.lastTickMs = now
      if (!this.d.enabled()) {
        // Kill switch: drop every lease once, evaluate nothing.
        if (this.wasEnabled || this.leases.size) {
          this.leases.clear()
          await this.d.act.setLightLeases([])
        }
        this.wasEnabled = false
        return
      }
      this.wasEnabled = true
      const rules = this.d.loadRules()
      this.syncRuntime(rules)
      for (const [id, l] of this.leases) if (l.expiresAt <= now) this.leases.delete(id)

      const active = rules.filter(r => r.enabled)
      const keys = new Set(active.flatMap(signalsOf))
      const snapshot = this.d.signals(podSlotsIn(keys))
      for (const key of windowedSignals(active)) {
        const v = snapshot[key]
        if (v !== undefined) this.windows.record(key, v, now)
      }
      this.windows.prune(now, maxWindowMin(active))
      const { nowMinutes, dayOfWeek, dateKey } = this.d.clock()

      for (const rule of active) {
        const ctx: EvalContext = { signal: k => snapshot[k], windows: this.windows, nowMs: now, nowMinutes, dayOfWeek, dateKey, sustain: this.sustain }
        try {
          recorded = (await this.evaluate(rule, ctx, now)) || recorded
        }
        catch (e) {
          this.d.recordRun(rule.id, 'error', { reason: 'eval-threw', message: (e as Error).message })
          recorded = true
        }
      }
      await this.d.act.setLightLeases([...this.leases.values()])
    }
    finally {
      this.ticking = false
      if (recorded) this.d.changed?.()
    }
  }

  /** Reset state for rules whose trigger or conditions changed, and forget deleted rules. */
  private syncRuntime(rules: AutomationRule[]): void {
    const ids = new Set(rules.map(r => r.id))
    for (const id of [...this.runtime.keys()]) {
      if (!ids.has(id)) this.forget(id)
    }
    for (const r of rules) {
      const fp = JSON.stringify([r.trigger, r.conditions, r.actions, r.dryRun])
      const rt = this.runtime.get(r.id)
      if (rt && rt.fingerprint !== fp) this.forget(r.id)
      if (!r.enabled) this.dropLeases(r.id)
      if (!this.runtime.has(r.id)) {
        this.runtime.set(r.id, { fingerprint: fp, lastFiredMs: rt && rt.fingerprint === fp ? rt.lastFiredMs : null, actionTimes: [], lastTriggerSeen: false, lastTickEvalMs: 0, condition: undefined })
      }
    }
  }

  private forget(id: number): void {
    this.runtime.delete(id)
    this.sustain.reset(`r${id}:`)
    this.dropLeases(id)
  }

  private dropLeases(ruleId: number, policiesOnly = false): void {
    for (const [id, l] of this.leases) if (l.ruleId === ruleId && (!policiesOnly || l.policy)) this.leases.delete(id)
  }

  private triggerActive(rule: AutomationRule, ctx: EvalContext, now: number, rt: Runtime): boolean {
    const t = rule.trigger
    switch (t.kind) {
      case 'tick': {
        const due = now - rt.lastTickEvalMs >= t.everyMin * 60_000 - 1000
        if (due) rt.lastTickEvalMs = now
        return due
      }
      case 'signalChange': {
        const v = ctx.signal(t.signal)
        if (v === undefined) return false
        const changed = rt.lastTriggerSeen && v !== rt.lastTriggerValue
        rt.lastTriggerValue = v
        rt.lastTriggerSeen = true
        return changed
      }
      case 'timeOfDay': {
        const [h = 0, m = 0] = t.at.split(':').map(Number)
        const at = h * 60 + m
        if (t.days && !t.days.includes(ctx.dayOfWeek)) return false
        if (ctx.nowMinutes < at || ctx.nowMinutes > at + TIME_OF_DAY_GRACE_MIN) return false
        const key = `${ctx.dateKey}:${at}`
        if (rt.lastTimeKey === key) return false
        rt.lastTimeKey = key
        return true
      }
    }
  }

  /** Returns whether a run row was written. */
  private async evaluate(rule: AutomationRule, ctx: EvalContext, now: number): Promise<boolean> {
    const rt = this.runtime.get(rule.id) as Runtime
    const triggered = this.triggerActive(rule, ctx, now, rt)
    const cond = evaluateCondition(rule.conditions, { ...ctx }, `r${rule.id}:c`)
    rt.condition = cond

    if (cond !== true) {
      this.dropLeases(rule.id, true)
      if (rule.actions.some(a => a.kind === 'notify')) this.d.act.clearNotice(rule)
      if (!triggered) return false
      this.d.recordRun(rule.id, 'skipped', { reason: cond === undefined ? 'condition-unknown' : 'condition-false', signals: values(rule, ctx) })
      return true
    }

    // A policy keeps its lease while the condition holds; one whose lease is missing (after a
    // restart, an edit or the kill switch) takes the light back without replaying other actions.
    for (const l of this.leases.values()) {
      if (l.ruleId === rule.id && l.policy) l.expiresAt = now + 2 * AUTOPILOT_TICK_MS
    }
    const reacquire = new Set<number>()
    if (!rule.dryRun) {
      rule.actions.forEach((a, i) => {
        if (a.kind === 'setLight' && isPolicy(rule, a) && !this.leases.has(leaseId(rule.id, i))) reacquire.add(i)
      })
    }
    if (!triggered && reacquire.size === 0) return false

    if (triggered && rule.cooldownMin && rt.lastFiredMs !== null && now - rt.lastFiredMs < rule.cooldownMin * 60_000) {
      this.d.recordRun(rule.id, 'skipped', { reason: 'cooldown' })
      return true
    }

    rt.actionTimes = rt.actionTimes.filter(t => now - t < 3_600_000)
    if (rt.actionTimes.length >= AUTOPILOT_MAX_ACTIONS_PER_HOUR) {
      this.d.disableRule(rule.id)
      this.dropLeases(rule.id)
      this.d.recordRun(rule.id, 'error', { reason: 'runaway-disabled', actionsLastHour: rt.actionTimes.length })
      this.d.log?.(`autopilot: disabled rule ${rule.id} (${rule.name}) by the runaway guard`)
      return true
    }

    const results: ActionResult[] = []
    for (const [i, a] of rule.actions.entries()) {
      if (!triggered && !reacquire.has(i)) continue
      results.push(await this.run(rule, a, i, ctx, now))
    }
    const acted = results.filter(r => r.sent).length
    for (let i = 0; i < acted; i++) rt.actionTimes.push(now)
    if (triggered && results.some(r => r.sent || r.dryRun || r.antiThrash || r.kind === 'notify')) rt.lastFiredMs = now
    this.d.recordRun(rule.id, outcome(rule.dryRun, results), { actions: results, signals: values(rule, ctx), reacquired: !triggered })
    return true
  }

  private number(e: Parameters<typeof evaluateExpr>[0], ctx: EvalContext): number | undefined {
    const v = evaluateExpr(e, ctx)
    return v === undefined || !Number.isFinite(v) ? undefined : v
  }

  private async run(rule: AutomationRule, a: Action, index: number, ctx: EvalContext, now: number): Promise<ActionResult> {
    try {
      switch (a.kind) {
        case 'notify':
          if (rule.dryRun) return { kind: a.kind, dryRun: true }
          this.d.act.notify(rule, a.message)
          return { kind: a.kind }
        case 'setLight': {
          const raw = this.number(a.level, ctx)
          if (raw === undefined) {
            this.leases.delete(leaseId(rule.id, index))
            return { kind: a.kind, skipped: 'value-unknown' }
          }
          const value = Math.round(clamp(clamp(raw, a.clamp?.min, a.clamp?.max), 0, 100))
          const clamped = value !== Math.round(raw)
          if (rule.dryRun) return { kind: a.kind, raw, value, clamped, dryRun: true }
          const id = leaseId(rule.id, index)
          const prev = this.leases.get(id)
          const policy = isPolicy(rule, a)
          const antiThrash = prev !== undefined && Math.abs(prev.level - value) < AUTOPILOT_LIGHT_ANTI_THRASH
          this.leases.set(id, {
            id,
            ruleId: rule.id,
            policy,
            level: antiThrash && prev ? prev.level : value,
            priority: rule.priority,
            createdAt: prev?.createdAt ?? now,
            expiresAt: now + (policy ? 2 * AUTOPILOT_TICK_MS : (a.holdMinutes ?? AUTOPILOT_DEFAULT_HOLD_MIN) * 60_000),
          })
          return { kind: a.kind, raw, value, clamped, antiThrash, sent: !antiThrash }
        }
        case 'runPump': {
          const raw = this.number(a.durationS, ctx)
          if (raw === undefined) return { kind: a.kind, skipped: 'value-unknown' }
          const value = Math.max(1, Math.round(raw))
          if (rule.dryRun) return { kind: a.kind, raw, value, clamped: value !== raw, dryRun: true }
          await this.d.act.runPump(value, a.level)
          return { kind: a.kind, raw, value, clamped: value !== raw, sent: true }
        }
        case 'stopPump':
          if (rule.dryRun) return { kind: a.kind, dryRun: true }
          await this.d.act.stopPump()
          return { kind: a.kind, sent: true }
        case 'dose': {
          const raw = this.number(a.durationS, ctx)
          if (raw === undefined) return { kind: a.kind, skipped: 'value-unknown' }
          const value = Math.max(1, Math.round(raw))
          if (rule.dryRun) return { kind: a.kind, raw, value, clamped: value !== raw, dryRun: true }
          await this.d.act.dose(a.doser, value)
          return { kind: a.kind, raw, value, clamped: value !== raw, sent: true }
        }
        case 'setPodStatus':
          if (rule.dryRun) return { kind: a.kind, dryRun: true }
          this.d.act.setPodStatus(a.slot, a.status)
          return { kind: a.kind }
      }
    }
    catch (e) {
      if (e instanceof ActionRefused) return { kind: a.kind, refused: e.message }
      return { kind: a.kind, error: (e as Error).message }
    }
  }
}

export const leaseId = (ruleId: number, index: number) => `rule:${ruleId}:${index}`

/** Light actions hold while the condition does, unless they fire at a time of day or say otherwise. */
export function isPolicy(rule: Pick<AutomationRule, 'trigger'>, a: Extract<Action, { kind: 'setLight' }>): boolean {
  return a.mode ? a.mode === 'policy' : rule.trigger.kind !== 'timeOfDay'
}

/** The signals a rule read on this tick, for the audit row. */
function values(rule: AutomationRule, ctx: EvalContext): Record<string, number | null> {
  return Object.fromEntries(signalsOf(rule).map(k => [k, ctx.signal(k) ?? null]))
}

/** One outcome per run: the most important thing that happened. */
export function outcome(dryRun: boolean, results: ActionResult[]): RunOutcome {
  if (results.some(r => r.error)) return 'error'
  if (results.some(r => r.refused)) return 'refused'
  if (dryRun && results.some(r => r.dryRun)) return 'dry_run'
  if (results.every(r => r.skipped)) return 'skipped'
  if (results.some(r => r.clamped && (r.sent || r.antiThrash))) return 'clamped'
  return 'fired'
}
