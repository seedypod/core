/**
 * One sensor's history as a card (sleepypod's FlowrateChart pattern): the live
 * value and how fresh it is, a range picker, the chart with a hover readout,
 * and min / avg / max underneath, with loading, error and empty states.
 */
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Card, InlineError, Skeleton } from '@/src/components/ds/core'
import { SensorAge, type ChartGuide } from '@/src/components/ds/charts'
import { SegmentedControl } from '@/src/components/ds/forms'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { withUnit } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'
import { fmtDay, fmtTime } from './format'
import { TimeChart } from './TimeChart'

export type RangeHours = '6' | '24' | '168'
const RANGES: Array<{ value: RangeHours, label: string }> = [{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }]

const round = (v: number) => Math.round(v * 10) / 10

export function TrendCard({ sensor, title, color, latest, icon: Icon, defaultHours = '24', yMin, yMax, guides, height = 120, unit: unitOverride }: {
  sensor: SensorId
  title: string
  color: string
  latest?: Reading
  icon?: LucideIcon
  defaultHours?: RangeHours
  yMin?: number
  yMax?: number
  guides?: ChartGuide[]
  height?: number
  unit?: string
}) {
  const [hours, setHours] = useState<RangeHours>(defaultHours)
  const h = Number(hours)
  const q = trpc.telemetry.history.useQuery({ sensor, hours: h, maxPoints: h <= 24 ? 144 : 336 }, { refetchInterval: 60_000 })
  const unit = unitOverride ?? latest?.unit ?? ''
  const shown = (v: number) => (unit === 'pH' ? String(round(v)) : withUnit(round(v), unit))
  const points = q.data ?? []
  const values = points.map(p => p.value)
  const stats = values.length ? { min: Math.min(...values), avg: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) } : null
  return (
    <Card>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 truncate text-[13px] text-fg-2">
            {Icon && <Icon size={14} className="text-icon" />}
            {title}
            <SensorAge timestamp={latest?.ts} />
          </span>
          <span className="font-mono text-2xl font-light" data-testid={`trend-${sensor}-value`}>{latest ? shown(latest.value) : '—'}</span>
        </div>
        <SegmentedControl ariaLabel={`${title} range`} size="sm" value={hours} options={RANGES} onChange={setHours} />
      </div>
      {q.isLoading && <Skeleton className="h-[120px] w-full" />}
      {q.error && <InlineError>{`Couldn't load the ${title.toLowerCase()} history: ${q.error.message}`}</InlineError>}
      {!q.isLoading && !q.error && (
        <TimeChart
          series={[{ name: title, color, points: points.map(p => ({ x: Date.parse(p.ts), y: p.value })) }]}
          height={height}
          yMin={yMin}
          yMax={yMax}
          fill
          guides={guides}
          formatX={h <= 24 ? fmtTime : fmtDay}
          formatY={shown}
          empty={`No ${title.toLowerCase()} recorded in this window.`}
        />
      )}
      {stats && (
        <div className="flex justify-between border-t border-line pt-2 font-mono text-[11px] text-fg-2" data-testid={`trend-${sensor}-stats`}>
          <span>{`min ${shown(stats.min)}`}</span>
          <span>{`avg ${shown(stats.avg)}`}</span>
          <span>{`max ${shown(stats.max)}`}</span>
        </div>
      )}
    </Card>
  )
}
