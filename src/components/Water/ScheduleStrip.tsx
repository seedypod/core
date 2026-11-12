import { cn } from '@/lib/utils'
import { hour, type Light } from './scheduleWords'

/**
 * A schedule's day as a strip, 00 to 24: the light's window as a band and
 * each cycle a tick, in the water's blue when it's the one running, muted
 * when it isn't, and amber where it falls outside the light.
 */
export function ScheduleStrip({ runs, light, tone = 'muted', warn = [], label, className }: {
  runs: ReadonlyArray<{ minute: number, durationS: number }>
  light: Light
  tone?: 'active' | 'muted'
  /** Minutes of the runs to mark as outside the light. */
  warn?: readonly number[]
  /** The band's label inside it, as in the editor's preview: "light 06–21". */
  label?: boolean
  className?: string
}) {
  return (
    <div className={cn('relative h-9 w-full overflow-hidden rounded-[6px] bg-active/40', className)} data-testid="schedule-strip">
      {light && (
        <div className="absolute inset-y-0 bg-active" style={{ left: `${(light.on / 1440) * 100}%`, width: `${((light.off - light.on) / 1440) * 100}%` }}>
          {label && <span className="absolute left-2 top-1 font-mono text-[10px] text-fg-3">{`light ${hour(light.on)}–${hour(light.off)}`}</span>}
        </div>
      )}
      {/* Two runs can share a minute while they're being edited. */}
      {runs.map((r, i) => (
        <span
          key={`${r.minute}-${i}`}
          data-minute={r.minute}
          className={cn('absolute bottom-1.5 w-[3px] -translate-x-1/2 rounded-full', label ? 'top-4' : 'top-1.5', warn.includes(r.minute) ? 'bg-pod-ready' : tone === 'active' ? 'bg-tank' : 'bg-fg-3')}
          style={{ left: `${((r.minute + Math.min(r.durationS, 1800) / 120) / 1440) * 100}%` }}
        />
      ))}
    </div>
  )
}

/** The hours under the strips: midnight to midnight, with when the light comes on and goes off. */
export function StripAxis({ light, className }: { light: Light, className?: string }) {
  const at = (m: number) => `${(m / 1440) * 100}%`
  return (
    <div className={cn('relative h-7 overflow-hidden font-mono text-[10px] leading-tight text-fg-3', className)} aria-hidden data-testid="strip-axis">
      <span className="absolute left-0 top-0">00</span>
      {light && <span className="absolute top-0 whitespace-nowrap" style={{ left: at(light.on) }}>{`${hour(light.on)} lights on`}</span>}
      {light && <span className="absolute top-0 -translate-x-full text-right" style={{ left: at(light.off) }}>{`lights off ${hour(light.off)}`}</span>}
      <span className="absolute right-0 top-0">24</span>
    </div>
  )
}
