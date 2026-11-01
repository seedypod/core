import { History } from 'lucide-react'
import { useState } from 'react'
import { TimeChart } from '@/src/components/charts/TimeChart'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds/core'
import { SegmentedControl } from '@/src/components/ds/forms'
import type { RuleInput } from '@/src/autopilot/schema'
import { trpc } from '@/src/utils/trpc'

const WINDOWS = [{ value: '24', label: '1 day' }, { value: '72', label: '3 days' }, { value: '168', label: '7 days' }] as const

const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Replays a saved rule (id) or the draft being edited (rule) over recorded history. */
export function BacktestPanel({ id, rule }: { id?: number, rule?: Omit<RuleInput, 'enabled' | 'dryRun'> & Partial<Pick<RuleInput, 'enabled' | 'dryRun'>> }) {
  const [hours, setHours] = useState<'24' | '72' | '168'>('24')
  const run = trpc.automations.backtest.useMutation()
  const r = run.data
  const stepMin = hours === '24' ? 5 : 15
  const start = () => run.mutate({ id, rule: rule ? { enabled: true, dryRun: true, ...rule } : undefined, hours: Number(hours), stepMin })
  const fired = new Set((r?.fires ?? []).map(f => f.at))
  const series = (r?.traces ?? []).filter(t => t.values.some(v => v !== null)).slice(0, 3).map(t => ({
    name: `${t.label}${t.unit && t.unit !== '1/0' && t.unit !== t.label ? ` (${t.unit})` : ''}`,
    points: t.values.flatMap((v, i) => (v === null ? [] : [{ x: Date.parse(r?.times[i] ?? ''), y: v }])),
  }))
  return (
    <Card>
      <CardHeader
        title="Backtest"
        subtitle="What this rule would have done, replayed over recorded history. Nothing is sent to the hardware."
        icon={History}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SegmentedControl ariaLabel="Backtest window" size="sm" value={hours} options={WINDOWS} onChange={setHours} />
        <Button size="sm" disabled={run.isPending} onClick={start}>{run.isPending ? 'Replaying…' : 'Run backtest'}</Button>
      </div>
      {run.error && <InlineError className="mt-2">{run.error.message}</InlineError>}
      {r && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-[13px] text-fg">
            {r.summary.fires === 0 ? 'Would not have fired.' : `Would have fired ${r.summary.fires} time${r.summary.fires === 1 ? '' : 's'}.`}
            {r.summary.suppressed > 0 && ` ${r.summary.suppressed} more held back by the cooldown or the runaway guard.`}
            {r.summary.unknownSteps > 0 && ` Missing data on ${r.summary.unknownSteps} of ${r.times.length} steps.`}
          </p>
          {r.summary.disabledAt && <InlineError>{`The runaway guard would have disabled it at ${when(r.summary.disabledAt)}.`}</InlineError>}
          {r.liveOnly.length > 0 && <p className="text-xs text-fg-3">{`Not recorded, so unknown here: ${r.liveOnly.join(', ')}.`}</p>}
          {series.length > 0 && <TimeChart series={series} height={140} formatX={x => new Date(x).toLocaleDateString()} formatY={y => String(Math.round(y * 100) / 100)} />}
          {fired.size > 0 && (
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto font-mono text-[12px] text-fg-2" aria-label="Backtest fires">
              {r.fires.slice(0, 50).map(f => (
                <li key={f.at}>
                  {`${when(f.at)} · ${f.actions.map(a => `${a.kind}${a.value !== undefined ? ` ${a.value}` : ''}${a.clamped ? ' (clamped)' : ''}`).join(', ')}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}
