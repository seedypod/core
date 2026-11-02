/** Pieces of the Autopilot screen: the mode control, the backtest sparkline, the last-24-hours lanes and the activity log. */
import { cn } from '@/lib/utils'
import { withUnit } from '@/src/lib/sensorMeta'
import { StatusDot } from '@/src/components/ds/core'
import { SegmentedControl } from '@/src/components/ds/forms'
import { CheckCircle2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { byDay, matchesFilter, OUTCOME, why, type ActivityFilter, type BacktestSummary, type RuleMode } from './autopilotLogic'

const MODES: Array<{ value: RuleMode, label: string, on: string }> = [
  { value: 'off', label: 'Off', on: 'bg-active text-fg' },
  { value: 'dryrun', label: 'Dry-run', on: 'bg-[color-mix(in_oklab,var(--status-warn)_16%,transparent)] text-[var(--status-warn)]' },
  { value: 'active', label: 'Active', on: 'bg-[color-mix(in_oklab,var(--status-ok)_16%,transparent)] text-[var(--status-ok)]' },
]

/** Off / Dry-run / Active, as one control (sleepypod's ModeControl). */
export function ModeControl({ value, onChange, name }: { value: RuleMode, onChange: (m: RuleMode) => void, name: string }) {
  return (
    <div role="radiogroup" aria-label={`${name} mode`} className="inline-flex rounded-ctl border border-line p-0.5">
      {MODES.map(m => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={value === m.value}
          onClick={(e) => {
            e.stopPropagation()
            if (value !== m.value) onChange(m.value)
          }}
          className={cn('cursor-pointer rounded-thumb border-0 px-2.5 py-[5px] text-xs transition-colors', value === m.value ? m.on : 'bg-transparent text-fg-3 hover:text-fg')}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/** The watched signal over the backtest window, its threshold dashed, and where the rule would have fired. */
export function Sparkline({ s, width = 180, height = 32 }: { s: BacktestSummary, width?: number, height?: number }) {
  const known = s.spark.filter((v): v is number => v !== null)
  const t = s.watch?.threshold
  const lo = Math.min(...known, t ?? Infinity)
  const hi = Math.max(...known, t ?? -Infinity)
  const span = hi - lo || 1
  const n = Math.max(1, s.spark.length - 1)
  const x = (i: number) => (i / n) * (width - 2) + 1
  const y = (v: number) => height - 3 - ((v - lo) / span) * (height - 6)
  let d = ''
  s.spark.forEach((v, i) => {
    if (v === null) return
    d += `${d && s.spark[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `
  })
  const label = s.watch
    ? `${s.watch.label} over ${s.days} days against ${withUnit(s.watch.threshold, s.watch.unit === '1/0' ? '' : s.watch.unit)}; ${s.wouldFire} would fire`
    : `${s.wouldFire} would fire over ${s.days} days`
  // With nothing recorded there is only the threshold to draw, across the middle.
  const ty = known.length > 0 && t !== undefined ? y(t) : height / 2
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 overflow-visible">
      {(t !== undefined || known.length === 0) && <line x1={0} x2={width} y1={ty} y2={ty} stroke={known.length > 0 ? 'var(--status-warn)' : 'var(--text-3)'} strokeOpacity={0.5} strokeDasharray="3 3" strokeWidth={1} />}
      {s.fireAt.map(i => <line key={i} x1={x(i)} x2={x(i)} y1={2} y2={height - 2} stroke="var(--status-warn)" strokeWidth={1.5} opacity={0.75} />)}
      {d && <path d={d} fill="none" stroke="var(--text-2)" strokeWidth={1.5} strokeLinejoin="round" />}
    </svg>
  )
}

export interface TimelineRun { automationId: number, firedAt: string, outcome: string }

/** How each outcome sits on a lane: a tick for a check with nothing to do, a dot for an action, a ring for a dry run. */
function Mark({ outcome, left, title }: { outcome: string, left: string, title: string }) {
  const base = 'absolute top-1/2 -translate-x-1/2 -translate-y-1/2'
  if (outcome === 'skipped') return <span title={title} data-outcome={outcome} className={cn(base, 'h-1.5 w-px bg-line-2')} style={{ left }} />
  if (outcome === 'dry_run') return <span title={title} data-outcome={outcome} className={cn(base, 'box-border size-[7px] rounded-full border-[1.5px] border-warn')} style={{ left }} />
  const fill = outcome === 'fired' || outcome === 'clamped' ? 'bg-ok' : 'bg-danger'
  return <span title={title} data-outcome={outcome} className={cn(base, 'size-[7px] rounded-full', fill)} style={{ left }} />
}

const DAY_MS = 24 * 3_600_000
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Each rule's last 24 hours as a lane of checks and actions (sleepypod's TonightCard). */
export function LastDayCard({ light, rules, runs, now, counts }: {
  light: string | null
  rules: Array<{ id: number, name: string, mode: RuleMode }>
  runs: TimelineRun[]
  now: number
  counts: ReactNode
}) {
  const from = now - DAY_MS
  const at = (iso: string) => `${((Date.parse(iso) - from) / DAY_MS) * 100}%`
  const marks = runs.filter(r => Date.parse(r.firedAt) >= from)
  const hours = [0, 6, 12, 18, 24].map(h => ({ h, label: h === 24 ? 'now' : hhmm(from + h * 3_600_000) }))
  return (
    <section aria-label="Last 24 hours" className="flex flex-col gap-3.5 rounded-[14px] border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h2 className="text-[15px] font-medium">Last 24 hours</h2>
          {light && <span className="text-xs text-fg-3">{light}</span>}
        </div>
        <span className="font-mono text-[11px] text-fg-3" data-testid="day-counts">{counts}</span>
      </div>
      {rules.length > 0 && (
        <div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-[13px] max-[600px]:grid-cols-1 max-[600px]:gap-y-1">
          {rules.map(r => (
            <div key={r.id} className="contents">
              <span className={cn('truncate', r.mode === 'off' ? 'text-fg-3' : 'text-fg-2')}>{r.name}</span>
              <div className="relative h-3.5" data-testid={`lane-${r.id}`}>
                {marks.filter(m => m.automationId === r.id).map(m => (
                  <Mark key={m.firedAt} outcome={m.outcome} left={at(m.firedAt)} title={`${OUTCOME[m.outcome]?.label ?? m.outcome} · ${hhmm(Date.parse(m.firedAt))}`} />
                ))}
              </div>
            </div>
          ))}
          <span className="max-[600px]:hidden" />
          <div className="flex justify-between font-mono text-[10px] text-fg-3">{hours.map(h => <span key={h.h}>{h.label}</span>)}</div>
        </div>
      )}
      <div className="flex flex-wrap gap-4 font-mono text-[11px] text-fg-3">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-px bg-fg-3" />
          check, nothing to do
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-[7px] rounded-full bg-ok" />
          acted
        </span>
        <span className="flex items-center gap-1.5">
          <span className="box-border size-[7px] rounded-full border-[1.5px] border-warn" />
          would act (dry-run)
        </span>
      </div>
    </section>
  )
}

const FILTERS: Array<{ value: ActivityFilter, label: string }> = [{ value: 'actions', label: 'Actions' }, { value: 'would', label: 'Would act' }, { value: 'problems', label: 'Refused' }, { value: 'all', label: 'All checks' }]
const PAGE = 50
const ago = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The audit log by day, filterable (sleepypod's ActivityCard). `idle` is the line shown when nothing acted. */
export function ActivityCard({ runs, names, idle }: { runs: Array<{ id: number, automationId: number, firedAt: string, outcome: string, detail: unknown }>, names: Map<number, string>, idle: string }) {
  const [filter, setFilter] = useState<ActivityFilter>('actions')
  const [limit, setLimit] = useState(PAGE)
  const matching = runs.filter(r => matchesFilter(r.outcome, filter))
  const shown = matching.slice(0, limit)
  return (
    <section aria-label="Activity" className="flex flex-col gap-3.5 rounded-[14px] border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
          <h2 className="text-[15px] font-medium">Activity</h2>
          <span className="text-xs text-fg-3">Every time a rule&apos;s trigger came round, and what it did</span>
        </div>
        <SegmentedControl ariaLabel="Activity filter" size="sm" value={filter} options={FILTERS} onChange={setFilter} />
      </div>
      {shown.length === 0 && (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-line p-[18px] text-[13px] text-fg-2">
          <CheckCircle2 size={16} className="shrink-0" />
          {runs.length === 0
            ? 'Nothing yet. Every time a rule\'s trigger comes round, its outcome lands here.'
            : filter === 'actions' ? idle : 'Nothing matches this filter.'}
        </div>
      )}
      {shown.length > 0 && (
        <div className="flex flex-col gap-2" aria-label="Run log" role="list">
          {byDay(shown).map(g => (
            <div key={g.day} role="presentation">
              <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-fg-3">{g.day}</div>
              {g.runs.map(run => (
                <div key={run.id} role="listitem" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-1.5 text-[13px] first:border-t-0">
                  <span className="w-[68px] shrink-0 whitespace-nowrap font-mono text-xs text-fg-3">{ago(run.firedAt)}</span>
                  <StatusDot tone={OUTCOME[run.outcome]?.tone ?? 'muted'} label={OUTCOME[run.outcome]?.label ?? run.outcome} />
                  <span className="text-fg">{names.get(run.automationId) ?? `rule ${run.automationId}`}</span>
                  <span className="text-fg-2">{why(run.detail)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {matching.length > shown.length && <button type="button" onClick={() => setLimit(l => l + PAGE)} className="self-start text-[13px] text-fg-2 underline-offset-2 hover:text-fg hover:underline">{`Show more (${matching.length - shown.length})`}</button>}
    </section>
  )
}
