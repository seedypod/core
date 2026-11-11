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
const SWITCH = /^follow:schedule:(.+)$/

/**
 * The care engine moved watering on with the grow protocol (`follow:<preset>`),
 * kept germination on the sowing weekday, or made the switch to one of Your
 * schedules queued for maintenance (`follow:schedule:<name>`).
 */
export function followSnack(e: CoreEvent): Snack | null {
  if (e.kind !== 'schedule' || e.action !== 'changed') return null
  const name = SWITCH.exec(e.id)?.[1]
  if (name) return { id: 'follow', tone: 'cool', icon: Sprout, title: `Watering switched to ${name}`, detail: 'Maintenance began', view: { to: '/grow', label: 'View' } }
  const to = FOLLOW.exec(e.id)?.[1]
  const preset = PUMP_PRESETS.find(p => p.id === to)
  if (!preset) return null
  const view = { to: '/water', label: 'View' }
  if (preset.id === 'germination') return { id: 'follow', tone: 'cool', icon: Sprout, title: 'Germination watering moved to the sowing weekday', view }
  return { id: 'follow', tone: 'cool', icon: Sprout, title: `Watering moved to ${preset.name}`, detail: preset.stage, view }
}

/** Why the pump stopped, from hald's "pump: dry-run" or the sim's "pump stopped: tank ran dry". */
const pumpReason = (detail: string) => detail.replace(/^pump(?: stopped)?:\s*/i, '').trim() || 'fault'

/**
 * A newly raised alert as a snack; reminders and chores are needs-you items,
 * not news, and Follow has its own. Each alert is its own toast, so two of a
 * kind both get said; the pump's share one, the latest saying why it's off.
 */
export function alertSnack(a: { id: number, kind: string, detail: string }): Snack | null {
  if (categoryOf(a.kind) === 'reminder' || a.kind === 'watering_followed') return null
  const view = alertView(a.kind)
  const go = view ? { to: view.to, label: 'View' } : undefined
  const hardware = categoryOf(a.kind) === 'hardware'
  const base = { id: `alert:${a.kind}:${a.id}`, urgent: hardware, tone: hardware ? 'danger' as const : 'warn' as const, view: go, shownOn: '/alerts' }
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
/** A start command and the run it started arrive in either order, this close together. */
const MANUAL_WINDOW_MS = 10_000

/**
 * Watches the pump for a manual run (one a person or agent started, so an
 * `actuators.pump.on` command comes with it) running its course, which says
 * "Watering finished". Scheduled runs finish quietly, a run stopped early was
 * stopped by whoever is looking, and a fault is the alert's snack. An on-state
 * with a new `since` before the run's planned end extends it (Run again while
 * watering): same start, the new end. One after the planned end is a new run,
 * as when an off went missing while the stream was down. A start command counts once.
 */
export function pumpWatch(now: () => number = Date.now) {
  // `changedAt`: when its latest start or extension arrived, which a command can trail.
  let run: { start: string, since: string, changedAt: number, endsAt: number | null, manual: boolean } | null = null
  let commandedAt = Number.NEGATIVE_INFINITY
  return (e: CoreEvent): Snack | null => {
    if (e.kind === 'mutation' && e.path === 'actuators.pump.on') {
      if (run && !run.manual && now() - run.changedAt <= MANUAL_WINDOW_MS) run.manual = true
      else commandedAt = now()
      return null
    }
    if (e.kind !== 'hal' || e.event.type !== 'actuator' || e.event.id !== 'pump') return null
    const s = e.event.state
    if (s.on) {
      // Re-sent states of the same run keep its start, end and whether it was manual.
      if (run?.since === s.since) return null
      const endsAt = s.remainingS === null ? null : Date.parse(s.since) + s.remainingS * 1000
      const commanded = now() - commandedAt <= MANUAL_WINDOW_MS
      commandedAt = Number.NEGATIVE_INFINITY
      if (run && (run.endsAt === null || Date.parse(s.since) < run.endsAt)) run = { ...run, since: s.since, changedAt: now(), endsAt, manual: run.manual || commanded }
      else run = { start: s.since, since: s.since, changedAt: now(), endsAt, manual: commanded }
      return null
    }
    const ended = run
    run = null
    if (!ended?.manual || s.fault || ended.endsAt === null || Date.parse(s.since) < ended.endsAt - END_SLACK_MS) return null
    const secs = Math.round((ended.endsAt - Date.parse(ended.start)) / 1000)
    return { id: 'pump-run', tone: 'ok', icon: CheckCircle2, title: 'Watering finished', detail: secs < 60 ? `${secs} s run` : `${Math.round(secs / 60)} min run`, view: { to: '/water', label: 'View' } }
  }
}
