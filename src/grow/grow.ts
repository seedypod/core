/**
 * Grow cycle — stage tracking and time-based reminders (thinning, root check,
 * harvest, nutrients). Reminders become persisted alerts so the UI, Home
 * Assistant and MCP all see and acknowledge the same thing.
 */
import type { EventBus } from '../lib/eventBus'
import type { DeviceSettings, GrowCycle, GrowStage, Store } from '../store/types'

export type ReminderKind = 'reminder_thinning' | 'reminder_root_check' | 'reminder_harvest' | 'reminder_nutrients' | 'reminder_sow'

export interface Reminder {
  kind: ReminderKind
  /** Day of the cycle on which it is due. */
  dueDay: number
  detail: string
}

const DAY_MS = 86_400_000

/** How far back a cycle may be dated, in days on the unit's calendar: past this, every reminder would fire at once. */
export const MAX_BACKDATE_DAYS = 120

export function cycleDay(cycle: GrowCycle, now: Date): number {
  return Math.floor((now.getTime() - new Date(cycle.startedAt).getTime()) / DAY_MS)
}

/** Reminders due on or before `now` that have not been issued for this cycle. */
export function dueReminders(cycle: GrowCycle, settings: DeviceSettings, now: Date): Reminder[] {
  const day = cycleDay(cycle, now)
  const out: Reminder[] = []
  const oneShot: [ReminderKind, number, string][] = [
    ['reminder_thinning', settings.thinningReminderDays, 'Thin seedlings to the strongest sprout per pod'],
    ['reminder_root_check', settings.rootCheckReminderDays, 'Check roots for length and colour; trim if they reach the pump'],
    ['reminder_harvest', settings.harvestReminderDays, 'First harvest window — pick outer leaves to keep plants producing'],
  ]
  for (const [kind, days, detail] of oneShot) {
    if (days > 0 && day >= days && !cycle.issued.includes(kind)) out.push({ kind, dueDay: days, detail })
  }
  if (settings.nutrientReminderDays > 0 && day > 0) {
    // Recurring: issue once per period; the issued key carries the period index.
    const period = Math.floor(day / settings.nutrientReminderDays)
    const key = `reminder_nutrients:${period}`
    if (period > 0 && !cycle.issued.includes(key)) {
      out.push({ kind: 'reminder_nutrients', dueDay: period * settings.nutrientReminderDays, detail: `Add nutrients (every ${settings.nutrientReminderDays} days)` })
    }
  }
  return out
}

/** The day of the cycle a reminder key fell due, by the settings that issue it; null for keys it doesn't know. */
function issuedDueDay(key: string, settings: DeviceSettings): number | null {
  const oneShot: Record<string, number> = { reminder_thinning: settings.thinningReminderDays, reminder_root_check: settings.rootCheckReminderDays, reminder_harvest: settings.harvestReminderDays }
  if (key in oneShot) return oneShot[key] ?? null
  const period = /^reminder_nutrients:(\d+)$/.exec(key)?.[1]
  return period === undefined ? null : Number(period) * settings.nutrientReminderDays
}

/**
 * A cycle moved to start on another day: the reminders it issued that aren't
 * due yet by its new day go back to waiting, and its stage is read again
 * from that day (germination to day 7, seedling to 13, then vegetative; a
 * harvest already called past the seedling days stays).
 */
export function restarted(cycle: GrowCycle, settings: DeviceSettings, day: number): { issued: string[], stage: GrowStage } {
  const issued = cycle.issued.filter((k) => {
    const due = issuedDueDay(k, settings)
    return due === null || due <= day
  })
  const stage: GrowStage = day < 8 ? 'germination' : day < 14 ? 'seedling' : cycle.stage === 'harvest' ? 'harvest' : 'vegetative'
  return { issued, stage }
}

export class GrowEngine {
  constructor(readonly deps: { store: Store, events: EventBus, now?: () => Date }) {}

  /** Sow reminders for later waves of applied plans whose date has come. Idempotent. */
  sowTick(): string[] {
    const { store, events } = this.deps
    const now = (this.deps.now ?? (() => new Date()))()
    const today = now.toISOString().slice(0, 10)
    const due: string[] = []
    for (const plan of store.plans.list()) {
      if (!plan.appliedAt) continue
      for (const w of plan.sowing) {
        const key = `${w.plantId}:${w.wave}:${w.sowOn}`
        if (w.wave <= 1 || w.sowOn > today || plan.issued.includes(key)) continue
        due.push(`${w.plantName} (wave ${w.wave})`)
        store.plans.markIssued(plan.id, key)
      }
    }
    if (due.length) {
      store.alerts.raise('reminder_sow', `Start new yCubes: ${due.join(', ')}`, now.toISOString())
      events.emit({ kind: 'mutation', path: 'alerts.reminder_sow' })
    }
    return due
  }

  /** Issue any due reminders as alerts. Idempotent. */
  tick(): Reminder[] {
    this.sowTick()
    const { store, events } = this.deps
    const now = (this.deps.now ?? (() => new Date()))()
    const cycle = store.grow.current()
    if (!cycle) return []
    const due = dueReminders(cycle, store.settings.get(), now)
    for (const r of due) {
      store.alerts.raise(r.kind, r.detail, now.toISOString())
      const issuedKey = r.kind === 'reminder_nutrients' ? `reminder_nutrients:${Math.floor(r.dueDay / Math.max(1, store.settings.get().nutrientReminderDays))}` : r.kind
      store.grow.markIssued(issuedKey)
      events.emit({ kind: 'mutation', path: `alerts.${r.kind}` })
    }
    return due
  }

  /** Acknowledging a reminder clears its alert (the chore is done). */
  acknowledge(kind: ReminderKind): void {
    const now = (this.deps.now ?? (() => new Date()))().toISOString()
    const { store } = this.deps
    const a = store.alerts.list({ activeOnly: true }).find(x => x.kind === kind)
    if (a) {
      store.alerts.acknowledge(a.id, now)
      store.alerts.clear(kind, now)
      this.deps.events.emit({ kind: 'mutation', path: `alerts.${kind}` })
    }
  }
}
