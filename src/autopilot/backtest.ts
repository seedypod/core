/**
 * Backtest (ADR-0020): what a rule would have done over recorded history.
 *
 * It drives the real AutopilotEngine with a simulated clock, signals rebuilt
 * from the store at each step, and actions that only record what they were
 * asked to do, so a backtest can't drift from live behaviour. Nothing touches
 * hardware. Actuator-state signals aren't recorded historically and read as
 * unknown; the result lists them.
 */
import { cycleDay } from '../grow/grow'
import { SensorId } from '../hardware/contract'
import { localTime } from '../scheduler/time'
import type { Store } from '../store/types'
import { signalsOf } from './ast'
import { AutopilotEngine, type ActionResult } from './engine'
import { catalog, slope } from './signals'
import type { AutomationRule, DayOfWeek, RunOutcome } from './types'

interface Sample { t: number, v: number }

export interface BacktestInput {
  rule: Omit<AutomationRule, 'id' | 'enabled'>
  fromMs: number
  toMs: number
  stepMin: number
}

export interface BacktestResult {
  from: string
  to: string
  stepMin: number
  /** ISO time of every step. */
  times: string[]
  /** Each signal the rule reads, aligned to `times`; null where it had no value. */
  traces: Array<{ key: string, label: string, unit: string, values: Array<number | null> }>
  /** Signals that read unknown throughout because they aren't recorded. */
  liveOnly: string[]
  fires: Array<{ at: string, outcome: RunOutcome, actions: ActionResult[] }>
  suppressed: Array<{ at: string, reason: string }>
  summary: { fires: number, suppressed: number, unknownSteps: number, disabledAt: string | null }
}

const DAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const SENSOR_MAX_AGE_MS = 15 * 60_000
const POD_MAX_AGE_MS = 36 * 3_600_000

/** Value of the latest sample at or before `t`, if it isn't older than `maxAge`. */
function at(buf: Sample[] | undefined, t: number, maxAge: number): number | undefined {
  if (!buf?.length) return undefined
  let lo = 0
  let hi = buf.length - 1
  if ((buf[0] as Sample).t > t) return undefined
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((buf[mid] as Sample).t <= t) lo = mid
    else hi = mid - 1
  }
  const s = buf[lo] as Sample
  return t - s.t <= maxAge ? s.v : undefined
}

/** Rebuild the history of every recorded signal a rule reads. */
function history(store: Store, keys: string[], fromMs: number, toMs: number) {
  const from = new Date(fromMs - 24 * 3_600_000).toISOString()
  const to = new Date(toMs).toISOString()
  const sensors = new Map<string, Sample[]>()
  const pods = new Map<number, Sample[]>()
  const alerts = new Map<string, Array<{ start: number, end: number }>>()
  const analyzer = store.settings.get().primaryAnalyzer
  for (const key of keys) {
    const sensor = /^sensor\.(.+)$/.exec(key)?.[1]
    if (sensor && SensorId.safeParse(sensor).success) {
      sensors.set(key, store.telemetry.range(sensor as SensorId, from, to, Number.MAX_SAFE_INTEGER).map(p => ({ t: Date.parse(p.ts), v: p.value })))
    }
    const pod = /^pod\.(\d+)\./.exec(key)?.[1]
    if (pod && !pods.has(Number(pod))) {
      pods.set(Number(pod), store.analyses.series({ analyzer, slot: Number(pod), metric: 'green_fraction', limit: 100_000 })
        .map(p => ({ t: Date.parse(p.ts), v: p.value })).filter(s => s.t <= toMs))
    }
    const kind = /^alert\.(.+)$/.exec(key)?.[1]
    if (kind && !alerts.has(kind)) {
      alerts.set(kind, store.alerts.list().filter(a => a.kind === kind)
        .map(a => ({ start: Date.parse(a.raisedAt), end: a.clearedAt ? Date.parse(a.clearedAt) : a.dismissedAt ? Date.parse(a.dismissedAt) : Number.POSITIVE_INFINITY })))
    }
  }
  const cycles = store.grow.history()
  return (t: number): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const [key, buf] of sensors) {
      const v = at(buf, t, SENSOR_MAX_AGE_MS)
      if (v !== undefined) out[key] = v
    }
    for (const [slot, buf] of pods) {
      const v = at(buf, t, POD_MAX_AGE_MS)
      if (v !== undefined) out[`pod.${slot}.green`] = v
      const upTo = buf.filter(s => s.t <= t).slice(-12).map(s => s.v)
      const tr = slope(upTo)
      if (tr !== undefined) out[`pod.${slot}.trend`] = tr
    }
    for (const [kind, spans] of alerts) out[`alert.${kind}`] = spans.some(s => s.start <= t && t < s.end) ? 1 : 0
    const cycle = cycles.find(c => Date.parse(c.startedAt) <= t && (!c.endedAt || t < Date.parse(c.endedAt)))
    if (cycle) out['grow.day'] = cycleDay(cycle, new Date(t))
    return out
  }
}

export async function backtest(store: Store, input: BacktestInput): Promise<BacktestResult> {
  const stepMs = input.stepMin * 60_000
  const rule: AutomationRule = { ...input.rule, id: 0, enabled: true, dryRun: false }
  const keys = signalsOf(rule)
  const info = new Map(catalog().map(c => [c.key, c]))
  const liveOnly = keys.filter(k => info.get(k)?.liveOnly)
  const signalsAt = history(store, keys, input.fromMs, input.toMs)
  const timezone = store.settings.get().timezone

  let now = input.fromMs
  let enabled = true
  let disabledAt: string | null = null
  const fires: BacktestResult['fires'] = []
  const suppressed: BacktestResult['suppressed'] = []
  let unknownSteps = 0
  const noop = async () => undefined
  const engine = new AutopilotEngine({
    now: () => now,
    clock: () => {
      const lt = localTime(new Date(now), timezone)
      return { nowMinutes: lt.minute, dayOfWeek: DAYS[lt.weekday] ?? 'monday', dateKey: lt.date }
    },
    signals: () => signalsAt(now),
    loadRules: () => [{ ...rule, enabled }],
    recordRun: (_id, outcome, detail) => {
      const d = detail as { reason?: string, actions?: ActionResult[] }
      const iso = new Date(now).toISOString()
      if (outcome === 'skipped' && d.reason === 'condition-unknown') unknownSteps++
      else if (outcome === 'skipped' && d.reason === 'cooldown') suppressed.push({ at: iso, reason: 'cooldown' })
      else if (outcome === 'error' && d.reason === 'runaway-disabled') suppressed.push({ at: iso, reason: 'runaway guard would disable the rule' })
      else if (outcome !== 'skipped' && d.actions) fires.push({ at: iso, outcome, actions: d.actions })
    },
    disableRule: () => {
      enabled = false
      disabledAt = new Date(now).toISOString()
    },
    enabled: () => true,
    act: { notify: () => undefined, clearNotice: () => undefined, setLightLeases: noop, runPump: noop, stopPump: noop, dose: noop, setPodStatus: () => undefined },
  })

  const times: string[] = []
  const traces = keys.map(key => ({ key, label: info.get(key)?.label ?? key, unit: info.get(key)?.unit ?? '', values: [] as Array<number | null> }))
  for (now = input.fromMs; now <= input.toMs; now += stepMs) {
    times.push(new Date(now).toISOString())
    const snap = signalsAt(now)
    for (const tr of traces) tr.values.push(snap[tr.key] ?? null)
    await engine.tick()
  }
  return {
    from: new Date(input.fromMs).toISOString(),
    to: new Date(input.toMs).toISOString(),
    stepMin: input.stepMin,
    times,
    traces,
    liveOnly,
    fires,
    suppressed,
    summary: { fires: fires.length, suppressed: suppressed.length, unknownSteps, disabledAt },
  }
}
