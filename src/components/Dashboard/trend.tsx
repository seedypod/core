/** Small trend pieces for Home's chips and panels, built on the design system's LineChart. */
import { LineChart } from '@/src/components/ds/charts'
import { withUnit } from '@/src/lib/sensorMeta'

export interface Point { ts: string, value: number }

const round = (v: number) => Math.round(v * 10) / 10
const clock = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function stats(points: Point[]): { min: number, avg: number, max: number } | null {
  if (points.length === 0) return null
  const values = points.map(p => p.value)
  return { min: round(Math.min(...values)), avg: round(values.reduce((a, b) => a + b, 0) / values.length), max: round(Math.max(...values)) }
}

/** A 24-hour chart with a hover readout and a min / avg / max row (sleepypod's HumidityChart pattern). */
export function Trend({ points, color, unit, label, height = 72 }: { points: Point[], color: string, unit: string, label: string, height?: number }) {
  const s = stats(points)
  if (!s) return <p className="py-3 text-xs text-fg-3">{`No ${label.toLowerCase()} recorded in the last 24 hours.`}</p>
  return (
    <div className="flex flex-col gap-1.5" aria-label={`${label}, last 24 hours`}>
      <LineChart series={[{ data: points.map(p => p.value), color, fill: true }]} height={height} xLabel={i => clock(points[i]?.ts ?? '')} format={v => withUnit(round(v), unit)} />
      <div className="flex justify-between border-t border-line pt-1.5 font-mono text-[11px] text-fg-2">
        <span>{`min ${withUnit(s.min, unit)}`}</span>
        <span>{`avg ${withUnit(s.avg, unit)}`}</span>
        <span>{`max ${withUnit(s.max, unit)}`}</span>
      </div>
    </div>
  )
}
