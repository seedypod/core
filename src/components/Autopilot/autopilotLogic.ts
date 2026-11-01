/**
 * View-model for the Autopilot screen (after sleepypod's automationsLogic):
 * rule modes, the header's status line, the backtest line on each rule, the
 * light-owner sentence and run-log copy. Pure, so it's tested without React.
 */
import { withUnit } from '@/src/lib/sensorMeta'

export type RuleMode = 'off' | 'dryrun' | 'active'

export function ruleMode(r: { enabled: boolean, dryRun: boolean }): RuleMode {
  if (!r.enabled) return 'off'
  return r.dryRun ? 'dryrun' : 'active'
}

/** The change a mode control asks for: Off disables; Dry-run and Active enable with dryRun on or off. */
export function modePatch(mode: RuleMode): { enabled: boolean, dryRun?: boolean } {
  return mode === 'off' ? { enabled: false } : { enabled: true, dryRun: mode === 'dryrun' }
}

/** `3 rules · 2 active · 1 dry-run`, dropping zero parts. */
export function statusLine(rules: Array<{ enabled: boolean, dryRun: boolean }>): string {
  const active = rules.filter(r => ruleMode(r) === 'active').length
  const dry = rules.filter(r => ruleMode(r) === 'dryrun').length
  const parts = [`${rules.length} rule${rules.length === 1 ? '' : 's'}`]
  if (active) parts.push(`${active} active`)
  if (dry) parts.push(`${dry} dry-run`)
  return rules.length ? parts.join(' · ') : 'no rules'
}

export interface BacktestSummary {
  days: number
  wouldFire: number
  suppressed: number
  disabledAt: string | null
  watch: { label: string, unit: string, op: string, threshold: number, extreme: number | null } | null
  spark: Array<number | null>
  fireAt: number[]
  liveOnly: string[]
}

const num = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
const HIGH_OPS = new Set(['>', '>=', '==', '!='])

/** `7-day backtest · 3 would fire · peak 31 of 30 °C`. */
export function backtestLine(s: BacktestSummary | undefined): string {
  if (!s) return 'backtesting…'
  const parts = [`${s.days}-day backtest`, `${s.wouldFire} would fire`]
  const w = s.watch
  if (w && w.extreme !== null) parts.push(`${HIGH_OPS.has(w.op) ? 'peak' : 'low'} ${num(w.extreme)} of ${withUnit(num(w.threshold), w.unit === '1/0' ? '' : w.unit)}`)
  else if (w) parts.push(`no recorded ${w.label}`)
  if (s.disabledAt) parts.push('runaway guard would stop it')
  return parts.join(' · ')
}

export interface LightOwner { source: 'manual' | 'autopilot' | 'schedule' | null, level: number | null, leaseId: string | null, manualUntil: string | null }

/** Who holds the light right now, in one line. */
export function lightLine(light: LightOwner, names: Map<number, string>): string {
  const who = light.source === 'manual'
    ? `held by hand until ${new Date(light.manualUntil ?? '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : light.source === 'autopilot'
      ? `set by ${names.get(Number(light.leaseId?.split(':')[1])) ?? 'a rule'}`
      : light.source === 'schedule' ? 'following the schedule' : 'idle'
  return `Light: ${who}${light.level !== null ? ` · ${light.level}%` : ''}`
}

export type Tone = 'ok' | 'warn' | 'danger' | 'muted'
export const OUTCOME: Record<string, { label: string, tone: Tone }> = {
  fired: { label: 'Fired', tone: 'ok' },
  clamped: { label: 'Fired (clamped)', tone: 'ok' },
  dry_run: { label: 'Would fire', tone: 'warn' },
  skipped: { label: 'Skipped', tone: 'muted' },
  refused: { label: 'Refused', tone: 'danger' },
  error: { label: 'Error', tone: 'danger' },
}

/** `actions` (the default) is everything but the checks where nothing happened. */
export type ActivityFilter = 'actions' | 'fired' | 'would' | 'problems' | 'all'
export function matchesFilter(outcome: string, f: ActivityFilter): boolean {
  if (f === 'actions') return outcome !== 'skipped'
  if (f === 'fired') return outcome === 'fired' || outcome === 'clamped'
  if (f === 'would') return outcome === 'dry_run'
  if (f === 'problems') return outcome === 'refused' || outcome === 'error'
  return true
}

/** Reasons and refusals from a run's detail, in a line a person can read. */
export function why(detail: unknown): string {
  const d = (detail ?? {}) as { reason?: string, actions?: Array<{ kind: string, value?: number, refused?: string, error?: string, skipped?: string }> }
  if (d.reason) return d.reason.replace(/-/g, ' ')
  return (d.actions ?? []).map(a => a.refused ?? a.error ?? (a.skipped ? `${a.kind}: ${a.skipped}` : `${a.kind}${a.value !== undefined ? ` ${a.value}` : ''}`)).join(', ')
}

/** Runs grouped by local day, newest day first, keeping each day's order. */
export function byDay<T extends { firedAt: string }>(runs: T[]): Array<{ day: string, runs: T[] }> {
  const out: Array<{ day: string, runs: T[] }> = []
  for (const r of runs) {
    const day = new Date(r.firedAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    const last = out.at(-1)
    if (last?.day === day) last.runs.push(r)
    else out.push({ day, runs: [r] })
  }
  return out
}
