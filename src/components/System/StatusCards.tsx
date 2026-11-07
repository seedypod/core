import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { fmtClock } from '@/src/components/charts/format'
import { asCycle, fmtMinutes } from '@/src/components/Water/pumpCycles'
import type { Reading } from '@/src/hardware/contract'
import { formatReading } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'
import { fmtAgo, minuteOfDay, niceRange, sparkline, startOfDay } from './statusData'
import { useDayHistory, useToday } from './TodayTimeline'
import { useNow } from './useNow'

const H12 = 12 * 3_600_000

interface CardProps {
  to: string
  title: string
  state: string
  stateTone: string
  head: string
  stats: Array<[string, string]>
  spark: string
  color: string
  foot: string
}

function StatusCard({ to, title, state, stateTone, head, stats, spark, color, foot }: CardProps) {
  return (
    <Link to={to} aria-label={title} className="flex min-w-0 flex-col gap-3.5 rounded-[14px] border border-line bg-surface px-5 py-[18px] text-fg hover:border-line-2">
      <div className="flex items-baseline gap-2.5">
        <h2 className="flex-1 text-[15px] font-semibold">{title}</h2>
        <span className={cn('font-mono text-[11px] font-medium tracking-[0.08em]', stateTone)}>{state}</span>
        <span className="font-mono text-sm">{head}</span>
      </div>
      <dl className="grid grid-cols-3 gap-2.5">
        {stats.map(([k, v]) => (
          <div key={k} className="flex min-w-0 flex-col gap-1">
            <dt className="text-xs text-fg-3">{k}</dt>
            <dd className="truncate font-mono text-sm">{v}</dd>
          </div>
        ))}
      </dl>
      <svg viewBox="0 0 200 40" preserveAspectRatio="none" className="block h-9 w-full" aria-hidden>
        <polyline points={spark} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="font-mono text-[11px] text-fg-3">{foot}</div>
    </Link>
  )
}

const series = (pts: ReadonlyArray<{ ts: string, value: number }> | undefined) => (pts ?? []).map(p => ({ t: Date.parse(p.ts), value: p.value }))
const OWNER = { schedule: 'SCHEDULE', autopilot: 'AUTOPILOT', manual: 'MANUAL' } as const

/** Light, Water and Climate at a glance, each linking to its page. */
export function StatusCards() {
  const nowMs = useNow(60_000)
  const now = new Date(nowMs)
  const nowMin = minuteOfDay(now)
  const today = useToday(now)
  const light = trpc.light.get.useQuery()
  const owner = trpc.light.owner.useQuery()
  const hours = trpc.telemetry.lightHours.useQuery()
  const pump = trpc.pump.get.useQuery()
  const latest = trpc.sensors.latest.useQuery()
  const schedules = trpc.schedules.list.useQuery()
  const runs = trpc.schedules.recentRuns.useQuery()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const devices = trpc.devices.list.useQuery()
  const tank = useDayHistory('water_level_pct')
  const air = useDayHistory('air_temp')
  const s: Partial<Record<string, Reading>> = latest.data ?? {}
  const from = nowMs - H12

  // Light: no recorded level, so the sparkline is what today's curves asked for.
  const l = light.data
  const curvePts = today.curve.length
    ? Array.from({ length: 49 }, (_, i) => {
        const t = from + (i / 48) * H12
        const sample = today.curve[Math.floor(minuteOfDay(new Date(t)) / 15) % today.curve.length]
        return { t, value: sample?.level ?? 0 }
      })
    : []
  const nextSet = today.setpoints.filter(p => p.minute > nowMin).sort((a, b) => a.minute - b.minute)[0]
  const src = owner.data?.source ?? null

  const pumpIds = new Set((schedules.data ?? []).map(asCycle).filter(c => c !== null).map(c => c.id))
  const lastRun = (runs.data ?? []).filter(r => pumpIds.has(r.scheduleId)).map(r => r.firedAt).sort().at(-1)
  const nextPump = today.cycles.map(c => c.spec.minute).filter(m => m > nowMin).sort((a, b) => a - b)[0]
  const tankPts = series(tank.data)
  const [tLo, tHi] = niceRange(tankPts.filter(p => p.t >= from).map(p => p.value), 20, 5, 0, 100)
  const durations = [...new Set(today.cycles.map(c => c.spec.durationS))]
  const cyclesLine = today.cycles.length ? `${fmtMinutes(durations[0] as number)}${durations.length > 1 ? '+' : ''} × ${today.cycles.length} today` : 'no pump cycles today'

  const airPts = series(air.data)
  const todayAir = airPts.filter(p => p.t >= startOfDay(now).getTime()).map(p => p.value)
  const [aLo, aHi] = niceRange(airPts.filter(p => p.t >= from).map(p => p.value), 6, 1)
  const hot = (alerts.data ?? []).some(a => a.active && a.kind === 'over_temp')
  const parts = [...new Set((devices.data?.sensors ?? []).filter(d => d.status === 'ready' && d.ids.some(id => ['air_temp', 'humidity', 'pcb_temp'].includes(id))).map(d => d.kind.toUpperCase().replace(/_/g, '-')))]

  return (
    <div className="grid grid-cols-1 gap-3 min-[900px]:grid-cols-3">
      <StatusCard
        to="/light"
        title="Light"
        state={src ? OWNER[src] : l?.on ? 'ON' : 'OFF'}
        stateTone={src || l?.on ? 'text-light' : 'text-fg-3'}
        head={l ? (l.on ? `${l.level}%` : 'off') : '—'}
        stats={[
          ['On since', l?.on ? fmtClock(Math.floor(minuteOfDay(new Date(l.since)))) : 'off'],
          ['Next', nextSet ? fmtClock(nextSet.minute) : '—'],
          ['LED hours', hours.data ? Math.round(hours.data.hours).toLocaleString('en-US') : '—'],
        ]}
        spark={sparkline(curvePts, from, nowMs, 0, 100)}
        color="var(--color-light)"
        foot={hours.data ? `${hours.data.pctUsed}% of ${hours.data.ratedHours.toLocaleString('en-US')} rated hours` : '—'}
      />
      <StatusCard
        to="/water"
        title="Water"
        state={pump.data?.on ? 'RUNNING' : 'IDLE'}
        stateTone={pump.data?.on ? 'text-water' : 'text-fg-2'}
        head={formatReading(s.water_level_pct)}
        stats={[
          ['Last run', lastRun ? fmtAgo(lastRun, nowMs) : '—'],
          ['Pump', formatReading(s.pump_v)],
          ['Next', nextPump !== undefined ? fmtClock(nextPump) : '—'],
        ]}
        spark={sparkline(tankPts, from, nowMs, tLo, tHi)}
        color="var(--color-water)"
        foot={s.water_distance ? `${cyclesLine} · ${formatReading(s.water_distance)} to water` : cyclesLine}
      />
      <StatusCard
        to="/sensors"
        title="Climate"
        state={hot ? 'HOT' : 'NORMAL'}
        stateTone={hot ? 'text-pod-attention' : 'text-pod-ok'}
        head={s.air_temp ? `${s.air_temp.value}°` : '—'}
        stats={[
          ['Humidity', formatReading(s.humidity)],
          ['Board', formatReading(s.pcb_temp)],
          ['Max today', todayAir.length ? `${Math.max(...todayAir).toFixed(1)}°` : '—'],
        ]}
        spark={sparkline(airPts, from, nowMs, aLo, aHi)}
        color="var(--color-fg)"
        foot={parts.length ? parts.join(' · ') : 'air, humidity and board sensors'}
      />
    </div>
  )
}
