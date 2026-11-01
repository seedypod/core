import { useEffect, useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* Lightweight SVG charts from the design system, ported from sleepypod's
   ds/charts.tsx: line charts that stretch to their card without stretching
   their strokes or labels, with a hover readout, guides and markers. */

/**
 * Where the pointer is across a chart box, as a 0..1 fraction of its width
 * (minus any padding), or null when outside. Every chart's hover readout is
 * built on this so they all behave alike.
 */
export function useHoverFraction(padLeft = 0, padRight = 0) {
  const [frac, setFrac] = useState<number | null>(null)
  const onPointerMove = (e: PointerEvent<Element>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const w = rect.width - padLeft - padRight
    if (w <= 0) return
    const x = e.clientX - rect.left - padLeft
    setFrac(x < 0 || x > w ? null : x / w)
  }
  const onPointerLeave = () => setFrac(null)
  return { frac, onPointerMove, onPointerLeave }
}

/** Vertical hover line with a readout, laid over a `relative` chart box at `pct` percent across. */
export function HoverMark({ pct, label, className, labelClassName }: { pct: number, label: ReactNode, className?: string, labelClassName?: string }) {
  const flip = pct > 55
  return (
    <div
      aria-hidden
      data-testid="chart-hover"
      className={cn('pointer-events-none absolute inset-y-0 border-l border-fg/35', className)}
      style={{ left: `${pct}%` }}
    >
      <span
        className={cn('absolute top-0 rounded-tag px-1 font-mono text-[10px] leading-4 whitespace-nowrap text-fg', flip ? 'right-1' : 'left-1', labelClassName)}
        style={{ background: 'color-mix(in srgb, var(--surface-card) 85%, transparent)' }}
      >
        {label}
      </span>
    </div>
  )
}

export interface LineSeries {
  data: number[]
  /** CSS color, e.g. 'var(--chart-water)'. */
  color: string
  dash?: boolean
  fill?: boolean
  width?: number
  /** Mark every point, so a value between two gaps still shows. */
  dots?: boolean
}

/** A horizontal rule at `value`; `strong` for a reference such as zero. */
export interface ChartGuide {
  value: number
  label?: string
  strong?: boolean
}

/** A vertical hairline at a fractional point index, e.g. 2.5 between points 2 and 3. */
export interface ChartMarker {
  at: number
  label: string
}

/**
 * Fluid-width sparkline/line chart. Non-finite points are skipped. Passing
 * `xLabel` turns on the hover readout: the label for the point under the
 * pointer and each series' value there (through `format`, default 1 decimal).
 */
export function LineChart({ series, min, max, height = 80, className, xLabel, format = v => v.toFixed(1), guides = [], markers = [] }: {
  series: LineSeries[]
  min?: number
  max?: number
  height?: number
  className?: string
  xLabel?: (index: number) => string
  format?: (value: number, series: number) => string
  guides?: ChartGuide[]
  markers?: ChartMarker[]
}) {
  const width = 300
  const hover = useHoverFraction()
  const all = series.flatMap(s => s.data).filter(Number.isFinite)
  if (all.length === 0) return <div className={className} style={{ height }} />
  const n = Math.max(...series.map(s => s.data.length))
  const idx = xLabel && hover.frac !== null && n > 0 ? Math.round(hover.frac * (n - 1)) : null
  const lo = min ?? Math.min(...all)
  const hi = max ?? Math.max(...all)
  const yOf = (v: number) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (height - 8)
  const xPct = (i: number) => (i / Math.max(1, n - 1)) * 100
  const points = (d: number[]) => d.flatMap((v, i) => Number.isFinite(v)
    ? [{ i, x: ((i / Math.max(1, d.length - 1)) * width).toFixed(1), y: yOf(v).toFixed(1) }]
    : [])
  const path = (d: number[]) => {
    let out = ''
    let last = -2
    for (const p of points(d)) {
      out += `${p.i === last + 1 ? 'L' : 'M'}${p.x},${p.y} `
      last = p.i
    }
    return out.trim()
  }
  const labelled = guides.filter(g => g.label)
  const bare = !xLabel && markers.length === 0 && labelled.length === 0
  const svg = (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn('block', bare && className)}>
      {guides.map(g => (
        <line
          key={`guide-${g.value}`}
          x1={0}
          x2={width}
          y1={yOf(g.value)}
          y2={yOf(g.value)}
          stroke={g.strong ? 'var(--text-3)' : 'var(--border-1)'}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {markers.map(m => (
        <line
          key={`marker-${m.label}`}
          x1={(xPct(m.at) / 100) * width}
          x2={(xPct(m.at) / 100) * width}
          y1={0}
          y2={height}
          stroke="var(--text-2)"
          strokeWidth={1}
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {series.map((s, i) => {
        const d = path(s.data)
        if (!d) return null
        return (
          <g key={i}>
            {s.fill && <path d={`${d} L${width},${height} L0,${height} Z`} fill={s.color} fillOpacity={0.1} />}
            <path
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width ?? 1.75}
              strokeDasharray={s.dash ? '4 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {/* Zero-length round-capped segments: dots that stay round under preserveAspectRatio="none". */}
            {s.dots && (
              <path
                data-testid="chart-dots"
                d={points(s.data).map(p => `M${p.x},${p.y} h0`).join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth={(s.width ?? 1.75) + 3}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
  if (bare) return svg
  const values = idx === null ? [] : series.map((s, i) => (Number.isFinite(s.data[idx]) ? format(s.data[idx], i) : null)).filter((v): v is string => v !== null)
  return (
    <div className={cn('relative', className)} onPointerMove={xLabel ? hover.onPointerMove : undefined} onPointerLeave={xLabel ? hover.onPointerLeave : undefined}>
      {svg}
      {labelled.map(g => (
        <span key={`guide-${g.value}`} aria-hidden className="pointer-events-none absolute right-full -translate-y-1/2 whitespace-nowrap pr-1.5 font-mono text-[10px] leading-3 text-fg-3" style={{ top: yOf(g.value) }}>
          {g.label}
        </span>
      ))}
      {markers.map(m => (
        <span
          key={`marker-${m.label}`}
          aria-hidden
          data-testid="chart-marker"
          className={cn('pointer-events-none absolute bottom-0 font-mono text-[10px] leading-3 whitespace-nowrap text-fg-2', xPct(m.at) > 55 ? 'pr-1' : 'pl-1')}
          style={xPct(m.at) > 55 ? { right: `${100 - xPct(m.at)}%` } : { left: `${xPct(m.at)}%` }}
        >
          {m.label}
        </span>
      ))}
      {idx !== null && xLabel && (
        <HoverMark pct={xPct(idx)} label={`${xLabel(idx)}${values.length ? ` · ${values.join(' / ')}` : ''}`} />
      )}
    </div>
  )
}

/** Circular score ring. */
export function QualityRing({ score, size = 96, label = 'quality', full, color = 'var(--status-ok)', text }: {
  score?: number | null
  size?: number
  label?: string | null
  full?: boolean
  color?: string
  text?: string
}) {
  const c = 2 * Math.PI * 42
  const frac = full ? 1 : Math.max(0, Math.min(1, (score ?? 0) / 100))
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 96 96">
        <circle cx="48" cy="48" r="42" fill="none" stroke="var(--dial-track)" strokeWidth="5" />
        <circle
          cx="48"
          cy="48"
          r="42"
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(c * frac).toFixed(1)} ${c.toFixed(1)}`}
          transform="rotate(-90 48 48)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono font-light leading-none" style={{ fontSize: size * 0.29 }}>{text ?? (score ?? '—')}</span>
        {label && size >= 80 && <span className="text-[11px] text-fg-2">{label}</span>}
      </div>
    </div>
  )
}

/** How old a reading is ("12s ago"), so a cached value never silently looks current. From sleepypod's SensorAge. */
export function SensorAge({ timestamp, className }: { timestamp?: string | number, className?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (timestamp === undefined) return null
  const at = typeof timestamp === 'number' ? timestamp * 1000 : Date.parse(timestamp)
  if (!Number.isFinite(at)) return null
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  const text = seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`
  return <span className={cn('font-mono text-[10px] font-normal tracking-normal text-fg-3 normal-case', className)}>{text}</span>
}
