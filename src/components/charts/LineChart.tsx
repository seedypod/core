import { useId } from 'react'
import { cn } from '@/lib/utils'

export interface Series { name: string, points: { x: number, y: number }[], color?: string }

/**
 * Small dependency-free SVG line chart on the design tokens. x is a number
 * (epoch ms or minute-of-day); the caller formats axis labels.
 */
export function LineChart({ series, height = 160, yMin, yMax, formatX, formatY, className, fill }: {
  series: Series[]
  height?: number
  yMin?: number
  yMax?: number
  formatX?: (x: number) => string
  formatY?: (y: number) => string
  className?: string
  fill?: boolean
}) {
  const id = useId()
  const pts = series.flatMap(s => s.points)
  if (pts.length === 0) return <div className={cn('flex items-center justify-center text-[12px] text-fg-3', className)} style={{ height }}>No data yet</div>
  const xs = pts.map(p => p.x)
  const ys = pts.map(p => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const lo = yMin ?? Math.min(...ys)
  const hi = yMax ?? Math.max(...ys)
  const pad = { l: 36, r: 8, t: 8, b: 20 }
  const W = 900
  const H = height
  const sx = (x: number) => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r)
  const sy = (y: number) => pad.t + (1 - (y - lo) / Math.max(1e-9, hi - lo)) * (H - pad.t - pad.b)
  const ticks = [lo, (lo + hi) / 2, hi]
  const fy = formatY ?? (y => String(Math.round(y)))
  const fx = formatX ?? (x => String(x))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn('block w-full', className)} style={{ height }} role="img" aria-label={series.map(s => s.name).join(', ')}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} className="stroke-grid" strokeWidth={1} />
          <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end" className="fill-fg-3 font-mono" fontSize={10}>{fy(t)}</text>
        </g>
      ))}
      <text x={pad.l} y={H - 4} className="fill-fg-3 font-mono" fontSize={10}>{fx(x0)}</text>
      <text x={W - pad.r} y={H - 4} textAnchor="end" className="fill-fg-3 font-mono" fontSize={10}>{fx(x1)}</text>
      {series.map((s, i) => {
        const d = s.points.map((p, j) => `${j === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')
        const color = s.color ?? ['var(--accent-light)', 'var(--accent-water)', 'var(--status-ok)', 'var(--chart-temp)'][i % 4]
        const last = s.points[s.points.length - 1]
        return (
          <g key={s.name}>
            {fill && last && (
              <path d={`${d} L${sx(last.x).toFixed(1)},${sy(lo).toFixed(1)} L${sx(s.points[0]?.x ?? 0).toFixed(1)},${sy(lo).toFixed(1)} Z`} fill={`url(#${id}-g${i})`} opacity={0.5} />
            )}
            <defs>
              <linearGradient id={`${id}-g${i}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity={0.35} />
                <stop offset="1" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        )
      })}
    </svg>
  )
}

export function fmtClock(minute: number): string {
  const h = Math.floor(minute / 60) % 24
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function fmtDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], { weekday: 'short', hour: '2-digit' })
}
