/**
 * A chart over time (or any numeric x) on the design system's LineChart:
 * points with irregular x are binned onto an even grid (averaged; empty bins
 * are gaps), with a hover readout, labelled y guides, x labels underneath and
 * a legend when there's more than one series. Replaces the old
 * stretch-to-fit SVG chart, whose text and strokes scaled with the card.
 */
import { LineChart, type ChartGuide, type ChartMarker } from '@/src/components/ds/charts'
import { cn } from '@/lib/utils'

export interface Series { name: string, points: { x: number, y: number }[], color?: string, dash?: boolean }

const PALETTE = ['var(--chart-water)', 'var(--accent-light)', 'var(--pod-ok)', 'var(--chart-temp)', 'var(--chart-humidity)']

/** Bridges runs of up to `maxGap` missing bins between two values, so sparse data reads as a line; longer runs stay gaps. */
export function bridge(data: number[], maxGap: number): number[] {
  const out = [...data]
  let last = -1
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i])) continue
    const gap = i - last - 1
    if (last >= 0 && gap > 0 && gap <= maxGap) {
      const a = out[last] as number
      const b = out[i] as number
      for (let j = 1; j <= gap; j++) out[last + j] = a + ((b - a) * j) / (gap + 1)
    }
    last = i
  }
  return out
}

/** Evenly spaced bins over the series' x range; each series' mean per bin, NaN where it has none. */
export function bin(series: Series[], maxBins: number): { xs: number[], data: number[][] } {
  const all = series.flatMap(s => s.points.map(p => p.x))
  if (all.length === 0) return { xs: [], data: series.map(() => []) }
  const x0 = Math.min(...all)
  const x1 = Math.max(...all)
  const n = Math.max(1, Math.min(maxBins, new Set(all).size))
  if (n === 1 || x1 === x0) return { xs: [x0], data: series.map(s => [s.points.length ? s.points.reduce((a, p) => a + p.y, 0) / s.points.length : Number.NaN]) }
  const width = (x1 - x0) / (n - 1)
  const xs = Array.from({ length: n }, (_, i) => x0 + i * width)
  const data = series.map((s) => {
    const sum = new Array<number>(n).fill(0)
    const count = new Array<number>(n).fill(0)
    for (const p of s.points) {
      const i = Math.min(n - 1, Math.max(0, Math.round((p.x - x0) / width)))
      sum[i] = (sum[i] ?? 0) + p.y
      count[i] = (count[i] ?? 0) + 1
    }
    return bridge(sum.map((v, i) => ((count[i] ?? 0) > 0 ? v / (count[i] as number) : Number.NaN)), Math.max(2, Math.round(n / 24)))
  })
  return { xs, data }
}

export function TimeChart({ series, height = 140, yMin, yMax, formatX = String, formatY = v => String(Math.round(v * 10) / 10), fill, guides, markers, maxBins = 120, className, empty = 'No data yet', label }: {
  series: Series[]
  height?: number
  yMin?: number
  yMax?: number
  formatX?: (x: number) => string
  formatY?: (y: number) => string
  fill?: boolean
  /** Extra horizontal rules, e.g. a threshold. */
  guides?: ChartGuide[]
  /** Vertical marks at an x value, e.g. "now". */
  markers?: Array<{ x: number, label: string }>
  maxBins?: number
  className?: string
  empty?: string
  /** Accessible name; the series names by default. */
  label?: string
}) {
  const { xs, data } = bin(series, maxBins)
  const finite = data.flat().filter(Number.isFinite)
  if (finite.length === 0) return <div className={cn('flex items-center justify-center text-[12px] text-fg-3', className)} style={{ height }}>{empty}</div>
  const lo = yMin ?? Math.min(...finite)
  const hi = yMax ?? Math.max(...finite)
  const x0 = xs[0] ?? 0
  const x1 = xs.at(-1) ?? 0
  const at = (x: number) => (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * (xs.length - 1))
  const chartMarkers: ChartMarker[] = (markers ?? []).filter(m => m.x >= x0 && m.x <= x1).map(m => ({ at: at(m.x), label: m.label }))
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? PALETTE[i % PALETTE.length] as string }))
  const mid = xs[Math.floor((xs.length - 1) / 2)]
  return (
    <div role="img" aria-label={label ?? series.map(s => s.name).join(', ')} className={cn('flex flex-col gap-1.5', className)}>
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-2" aria-label="Legend">
          {colored.map(s => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="inline-block w-3.5 border-t-2" style={{ borderColor: s.color, borderStyle: s.dash ? 'dashed' : 'solid' }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="pl-12">
        <LineChart
          series={colored.map((s, i) => ({ data: data[i] ?? [], color: s.color, dash: s.dash, fill: fill && series.length === 1 }))}
          min={lo}
          max={hi}
          height={height}
          xLabel={i => formatX(xs[i] ?? 0)}
          format={v => formatY(v)}
          guides={[{ value: hi, label: formatY(hi) }, { value: lo, label: formatY(lo) }, ...(guides ?? [])].filter((g, i, all) => all.findIndex(o => o.value === g.value) === i)}
          markers={chartMarkers}
        />
      </div>
      <div className="flex justify-between pl-12 font-mono text-[10px] text-fg-3" aria-hidden>
        <span>{formatX(x0)}</span>
        {xs.length > 2 && mid !== undefined && <span>{formatX(mid)}</span>}
        <span>{formatX(x1)}</span>
      </div>
    </div>
  )
}
