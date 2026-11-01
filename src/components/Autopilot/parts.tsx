/** Pieces of the Autopilot screen: the mode control, the backtest sparkline, today's timeline and the activity log. */
import { cn } from '@/lib/utils'
import { withUnit } from '@/src/lib/sensorMeta'
import { Card, CardHeader, StatusDot } from '@/src/components/ds/core'
import { SegmentedControl } from '@/src/components/ds/forms'
import { History, Sun } from 'lucide-react'
import { useState } from 'react'
import { byDay, matchesFilter, OUTCOME, why, type ActivityFilter, type BacktestSummary, type RuleMode } from './autopilotLogic'

const MODES: Array<{ value: RuleMode, label: string, on: string }> = [
  { value: 'off', label: 'Off', on: 'bg-active text-fg' },
  { value: 'dryrun', label: 'Dry-run', on: 'bg-[color-mix(in_oklab,var(--status-warn)_18%,transparent)] text-[var(--status-warn)]' },
  { value: 'active', label: 'Active', on: 'bg-[color-mix(in_oklab,var(--status-ok)_18%,transparent)] text-[var(--status-ok)]' },
]

/** Off / Dry-run / Active, as one control (sleepypod's ModeControl). */
export function ModeControl({ value, onChange, name }: { value: RuleMode, onChange: (m: RuleMode) => void, name: string }) {
  return (
    <div role="radiogroup" aria-label={`${name} mode`} className="inline-flex rounded-seg border border-line p-0.5">
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
          className={cn('cursor-pointer rounded-ctl border-0 px-2.5 py-1 text-[13px] transition-colors', value === m.value ? m.on : 'bg-transparent text-fg-2 hover:text-fg')}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/** The watched signal over the backtest window, its threshold dashed, and where the rule would have fired. */
export function Sparkline({ s, width = 168, height = 36 }: { s: BacktestSummary, width?: number, height?: number }) {
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
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 overflow-visible">
      {known.length > 0 && t !== undefined && <line x1={0} x2={width} y1={y(t)} y2={y(t)} stroke="var(--text-3)" strokeDasharray="3 3" strokeWidth={1} />}
      {s.fireAt.map(i => <line key={i} x1={x(i)} x2={x(i)} y1={2} y2={height - 2} stroke="var(--status-warn)" strokeWidth={1.5} opacity={0.75} />)}
      {d && <path d={d} fill="none" stroke="var(--accent-water)" strokeWidth={1.5} strokeLinejoin="round" />}
      {known.length === 0 && <text x={width / 2} y={height / 2 + 4} textAnchor="middle" className="fill-[var(--text-3)] font-mono text-[10px]">no recorded data</text>}
    </svg>
  )
}

export interface TimelineRun { automationId: number, firedAt: string, outcome: string }

const TONE_FILL: Record<string, string> = { ok: 'var(--status-ok)', warn: 'var(--status-warn)', danger: 'var(--status-danger)', muted: 'var(--text-3)' }

/** Who holds the light, and each rule's last 24 hours as a lane of fire marks (sleepypod's TonightCard). */
export function TodayCard({ light, rules, runs, now }: { light: string | null, rules: Array<{ id: number, name: string, mode: RuleMode }>, runs: TimelineRun[], now: number }) {
  const from = now - 24 * 3_600_000
  const at = (iso: string) => ((Date.parse(iso) - from) / (24 * 3_600_000)) * 100
  const marks = runs.filter(r => Date.parse(r.firedAt) >= from && r.outcome !== 'skipped')
  const hours = [0, 6, 12, 18, 24].map(h => ({ h, label: new Date(from + h * 3_600_000).toLocaleTimeString([], { hour: 'numeric' }) }))
  return (
    <Card>
      <CardHeader title="Today" subtitle={light ?? '…'} icon={Sun} />
      {rules.length > 0 && (
        <div className="mt-1 flex flex-col gap-2" aria-label="Last 24 hours">
          {rules.map(r => (
            <div key={r.id} className="grid grid-cols-[minmax(0,150px)_1fr] items-center gap-3 max-[600px]:grid-cols-1 max-[600px]:gap-1">
              <span className={cn('truncate text-[13px]', r.mode === 'off' ? 'text-fg-3' : 'text-fg')}>{r.name}</span>
              <div className="relative h-5 rounded-full bg-active" data-testid={`lane-${r.id}`}>
                {marks.filter(m => m.automationId === r.id).map(m => (
                  <span
                    key={m.firedAt}
                    title={`${OUTCOME[m.outcome]?.label ?? m.outcome} · ${new Date(m.firedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                    className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ left: `${at(m.firedAt)}%`, background: TONE_FILL[OUTCOME[m.outcome]?.tone ?? 'muted'] }}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="grid grid-cols-[minmax(0,150px)_1fr] gap-3 max-[600px]:grid-cols-1">
            <span />
            <div className="flex justify-between font-mono text-[10px] text-fg-3">{hours.map(h => <span key={h.h}>{h.h === 24 ? 'now' : h.label}</span>)}</div>
          </div>
        </div>
      )}
    </Card>
  )
}

const FILTERS: Array<{ value: ActivityFilter, label: string }> = [{ value: 'actions', label: 'Actions' }, { value: 'fired', label: 'Fired' }, { value: 'would', label: 'Would fire' }, { value: 'problems', label: 'Refused' }, { value: 'all', label: 'All checks' }]
const PAGE = 50
const ago = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The audit log by day, filterable (sleepypod's ActivityCard). */
export function ActivityCard({ runs, names }: { runs: Array<{ id: number, automationId: number, firedAt: string, outcome: string, detail: unknown }>, names: Map<number, string> }) {
  const [filter, setFilter] = useState<ActivityFilter>('actions')
  const [limit, setLimit] = useState(PAGE)
  const matching = runs.filter(r => matchesFilter(r.outcome, filter))
  const shown = matching.slice(0, limit)
  const skipped = runs.filter(r => r.outcome === 'skipped').length
  return (
    <Card>
      <CardHeader title="Activity" subtitle="Every time a rule's trigger came round, and what it did" icon={History} right={<SegmentedControl ariaLabel="Activity filter" size="sm" value={filter} options={FILTERS} onChange={setFilter} />} />
      {shown.length === 0 && (
        <p className="text-[13px] text-fg-2">
          {runs.length === 0
            ? 'Nothing yet. Every time a rule\'s trigger comes round, its outcome lands here.'
            : filter === 'actions' ? `No rule has acted recently. ${skipped} check${skipped === 1 ? '' : 's'} found nothing to do (All checks).` : 'Nothing matches this filter.'}
        </p>
      )}
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
      {matching.length > shown.length && <button type="button" onClick={() => setLimit(l => l + PAGE)} className="self-start text-[13px] text-fg-2 underline-offset-2 hover:text-fg hover:underline">{`Show more (${matching.length - shown.length})`}</button>}
    </Card>
  )
}
