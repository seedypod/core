import { CheckCircle2, Droplets, Sprout, Thermometer, TriangleAlert, Waves, type LucideIcon } from 'lucide-react'
import { alertView, categoryOf, describeAlert } from '@/src/components/Alerts/AlertsPage'
import type { NoticeTone } from '@/src/components/ds/notice'
import type { CoreEvent } from '@/src/lib/eventBus'
import { PUMP_PRESETS } from '@/src/scheduler/pumpPlan'

/**
 * A snackbar for something that just happened: what the toast says, where its
 * View goes, and the page that already shows it inline, where it stays quiet.
 * Needs-you items (reminders, chores) are never snacks: they stay in the
 * sidebar and on Alerts until done.
 */
export interface Snack {
  id: string
  tone: NoticeTone
  icon: LucideIcon
  title: string
  detail?: string
  urgent?: boolean
  view?: { to: string, label: string }
  /** The page that shows this itself, as the pump strip shows a fault on Water. */
  shownOn?: string
}

const FOLLOW = /^follow:(.+)$/

/** The care engine moved watering on with the grow cycle (`follow:<preset>`), or kept germination on the sowing weekday. */
export function followSnack(e: CoreEvent): Snack | null {
  if (e.kind !== 'schedule' || e.action !== 'changed') return null
  const to = FOLLOW.exec(e.id)?.[1]
  const preset = PUMP_PRESETS.find(p => p.id === to)
  if (!preset) return null
  const view = { to: '/water', label: 'View' }
  if (preset.id === 'germination') return { id: 'follow', tone: 'cool', icon: Sprout, title: 'Germination watering moved to the sowing weekday', view }
  return { id: 'follow', tone: 'cool', icon: Sprout, title: `Watering moved to ${preset.name}`, detail: preset.stage, view }
}

/** Why the pump stopped, from hald's "pump: dry-run" or the sim's "pump stopped: tank ran dry". */
const pumpReason = (detail: string) => detail.replace(/^pump(?: stopped)?:\s*/i, '').trim() || 'fault'

/** A newly raised alert as a snack; reminders and chores are needs-you items, not news, and Follow has its own. */
export function alertSnack(a: { kind: string, detail: string }): Snack | null {
  if (categoryOf(a.kind) === 'reminder' || a.kind === 'watering_followed') return null
  const view = alertView(a.kind)
  const go = view ? { to: view.to, label: 'View' } : undefined
  const hardware = categoryOf(a.kind) === 'hardware'
  const base = { id: `alert:${a.kind}`, urgent: hardware, tone: hardware ? 'danger' as const : 'warn' as const, view: go, shownOn: '/alerts' }
  if (a.kind === 'pump_fault') return { ...base, id: 'pump', icon: Waves, title: `Pump stopped: ${pumpReason(a.detail)}`, shownOn: '/water' }
  if (a.kind === 'water_low') return { ...base, id: 'pump', icon: Droplets, title: 'Pump off: water low', detail: 'It stays off until the tank is filled.', shownOn: '/water' }
  if (a.kind === 'over_temp') return { ...base, icon: Thermometer, title: 'Outputs off: board over temperature', detail: a.detail || undefined }
  const { title, detail } = describeAlert(a)
  // Autopilot notices have no label of their own; their detail names the rule.
  return { ...base, icon: TriangleAlert, title: title === a.kind && detail ? detail : title, detail: title === a.kind ? undefined : detail || undefined }
}

/**
 * The alerts in `next` that weren't open in `prev`, as snacks. Nothing before
 * the first list arrives, so opening the app doesn't replay what's open. A dry
 * run raises the pump fault and water low together: the fault says it.
 */
export function newAlertSnacks(prev: ReadonlyArray<{ id: number }> | undefined, next: ReadonlyArray<{ id: number, kind: string, detail: string }>): Snack[] {
  if (!prev) return []
  const seen = new Set(prev.map(a => a.id))
  const fresh = next.filter(a => !seen.has(a.id))
  const faulted = fresh.some(a => a.kind === 'pump_fault')
  return fresh.filter(a => !(faulted && a.kind === 'water_low')).map(alertSnack).filter((s): s is Snack => s !== null)
}

/** A run that ends within this of its planned end ran its course; earlier, someone stopped it. */
const END_SLACK_MS = 2_000
/** A pump command and the run it started arrive in either order, this close together. */
const MANUAL_WINDOW_MS = 10_000

/**
 * Watches the pump for a manual run (one a person or agent started, so a
 * `actuators.pump` mutation comes with it) running its course, which says
 * "Watering finished". Scheduled runs finish quietly, a run stopped early was
 * stopped by whoever is looking, and a fault is the alert's snack.
 */
export function pumpWatch(now: () => number = Date.now) {
  let run: { startedAt: number, endsAt: number | null, plannedS: number, manual: boolean } | null = null
  let commandedAt = Number.NEGATIVE_INFINITY
  return (e: CoreEvent): Snack | null => {
    if (e.kind === 'mutation' && e.path === 'actuators.pump') {
      if (run && now() - run.startedAt <= MANUAL_WINDOW_MS) run.manual = true
      else if (!run) commandedAt = now()
      return null
    }
    if (e.kind !== 'hal' || e.event.type !== 'actuator' || e.event.id !== 'pump') return null
    const s = e.event.state
    if (s.on) {
      // Re-sent states of the same run keep its start and end.
      run ??= { startedAt: now(), endsAt: s.remainingS === null ? null : Date.parse(s.since) + s.remainingS * 1000, plannedS: s.remainingS ?? 0, manual: now() - commandedAt <= MANUAL_WINDOW_MS }
      return null
    }
    const ended = run
    run = null
    if (!ended?.manual || s.fault || ended.endsAt === null || Date.parse(s.since) < ended.endsAt - END_SLACK_MS) return null
    const secs = ended.plannedS
    return { id: 'pump-run', tone: 'ok', icon: CheckCircle2, title: 'Watering finished', detail: secs < 60 ? `${secs} s run` : `${Math.round(secs / 60)} min run`, view: { to: '/water', label: 'View' } }
  }
}
