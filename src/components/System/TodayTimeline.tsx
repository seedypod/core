import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { describeAlert } from '@/src/components/Alerts/AlertsPage'
import { asCurve, runningToday } from '@/src/components/Light/curves'
import { asCycle } from '@/src/components/Water/pumpCycles'
import type { SensorId } from '@/src/hardware/contract'
import { dayOn, weekdayOf } from '@/src/lib/days'
import { trpc } from '@/src/utils/trpc'
import { useNow } from './useNow'
import {
  burstStarts, fmtIn, isToday, laneArea, lanePoints, laneTicks, layoutEvents, lightSeries, mergeCurves, minuteOfDay, nextJob, niceRange, todaySamples,
  type LaneEvent,
} from './statusData'

/** A day of one sensor's history, shared by the timeline (today) and the cards (last 12 h). */
export function useDayHistory(sensor: SensorId) {
  return trpc.telemetry.history.useQuery({ sensor, hours: 24, maxPoints: 480 }, { refetchInterval: 60_000 })
}

/** Today's schedules split the way the timeline and cards read them. */
export function useToday(now: Date) {
  const schedules = trpc.schedules.list.useQuery()
  const all = schedules.data ?? []
  const weekday = weekdayOf(now)
  const curves = runningToday(all.map(asCurve).filter(c => c !== null), weekday)
  const cycles = all.map(asCycle).filter(c => c !== null).filter(c => c.enabled && dayOn(c.days, weekday))
  const previews = trpc.useQueries(t => curves.map(c => t.schedules.previewCurve(c.spec)))
  const curve = mergeCurves(previews.map(p => p.data).filter(d => d !== undefined))
  const setpoints = curves.flatMap(c => c.spec.setpoints)
  return { curves, cycles, curve, setpoints, jobs: curves.length + cycles.length }
}

const TONE: Record<LaneEvent['tone'], string> = { muted: 'bg-fg-3', light: 'bg-light', down: 'bg-pod-attention' }

function Lane({ label, sub, nowPct, children }: { label: string, sub: string, nowPct: number, children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] border-t border-line" role="group" aria-label={label}>
      <div className="flex flex-col gap-0.5 py-3">
        <div className="text-sm">{label}</div>
        <div className="font-mono text-[11px] text-fg-3">{sub}</div>
      </div>
      <div className="relative h-16">
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-x-0 top-2 h-12 w-full overflow-visible" aria-hidden>{children}</svg>
        <NowLine pct={nowPct} />
      </div>
    </div>
  )
}

const NowLine = ({ pct }: { pct: number }) => <div className="absolute inset-y-0 border-l border-dashed border-line-2" style={{ left: `${pct}%` }} data-testid="now-line" />

/** Light, water and air from midnight to midnight with a dashed now line, then the day's events. */
export function TodayTimeline() {
  const nowMs = useNow(30_000)
  const now = new Date(nowMs)
  const nowMin = minuteOfDay(now)
  const nowPct = (nowMin / 1440) * 100
  const today = useToday(now)
  const light = trpc.light.get.useQuery()
  const runs = trpc.schedules.recentRuns.useQuery()
  const tank = useDayHistory('water_level_pct')
  const air = useDayHistory('air_temp')
  const backup = trpc.backup.status.useQuery()
  const autoRuns = trpc.automations.runs.useQuery({ limit: 500 })
  const rules = trpc.automations.list.useQuery()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: false })

  const lit = light.data ? (light.data.on ? light.data.level : 0) : null
  const lightLane = lightSeries(today.curve, nowMin, lit)
  const cycleIds = new Set(today.cycles.map(c => c.id))
  const minuteOf = (iso: string) => minuteOfDay(new Date(iso))
  const fromToday = (iso: string) => isToday(iso, now)
  const pumpPast = (runs.data ?? []).filter(r => cycleIds.has(r.scheduleId) && fromToday(r.firedAt)).map(r => minuteOf(r.firedAt))
  const pumpFuture = today.cycles.map(c => c.spec.minute).filter(m => m > nowMin)
  const tankPts = todaySamples(tank.data ?? [], now)
  const [tLo, tHi] = niceRange(tankPts.map(p => p.value), 20, 5, 0, 100)
  const airPts = todaySamples(air.data ?? [], now)
  const [aLo, aHi] = niceRange(airPts.map(p => p.value), 6, 1)
  const next = nextJob(today.setpoints, today.cycles.map(c => c.spec.minute), nowMin)

  const ruleName = new Map((rules.data ?? []).map(r => [r.id, r.name]))
  const events: LaneEvent[] = [
    ...(backup.data?.recent ?? []).filter(b => b.ok && fromToday(b.ts)).map(b => ({ minute: minuteOf(b.ts), label: 'Backup', tone: 'muted' as const })),
    ...burstStarts((autoRuns.data ?? []).filter(r => r.outcome === 'fired' && fromToday(r.firedAt)).map(r => ({ key: r.automationId, minute: minuteOf(r.firedAt) })))
      .map(r => ({ minute: r.minute, label: short(ruleName.get(r.key as number) ?? 'Autopilot'), tone: 'light' as const })),
    ...(alerts.data ?? []).filter(a => fromToday(a.raisedAt)).map(a => ({ minute: minuteOf(a.raisedAt), label: short(describeAlert(a).title), tone: a.kind.startsWith('reminder_') ? 'muted' as const : 'down' as const })),
  ]

  const laneRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = laneRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const placed = layoutEvents(events, width)
  const axis = [[0, '00:00'], [25, '06:00'], [50, '12:00'], [75, '18:00']] as const
  // An hour label gives way to "now" when they'd touch.
  const clear = (pct: number) => (Math.abs(pct - nowPct) / 100) * width > 40

  return (
    <section aria-label="Today" className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface px-[22px] pb-3.5 pt-[18px]">
      <div className="flex flex-wrap items-baseline gap-3 pb-2.5">
        <h2 className="text-[15px] font-semibold">Today</h2>
        <div className="min-w-[220px] flex-1 font-mono text-xs text-fg-3">{next ? `next: ${next.label} · ${fmtIn(next.minute - nowMin)}` : 'nothing else scheduled today'}</div>
        <Link to="/light" className="flex items-center gap-1.5 text-[13px] text-fg-2 hover:text-fg">
          <span className="font-mono">{today.jobs}</span>
          {` job${today.jobs === 1 ? '' : 's'} · Schedule`}
          <ArrowRight size={16} />
        </Link>
      </div>

      <Lane label="Light" sub="0–100%" nowPct={nowPct}>
        {lightLane.past.length > 1 && <path d={laneArea(lightLane.past, 0, 100)} fill="var(--color-light)" fillOpacity={0.12} />}
        <polyline points={lanePoints(lightLane.past, 0, 100)} fill="none" stroke="var(--color-light)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" data-testid="light-past" />
        <polyline points={lanePoints(lightLane.future, 0, 100)} fill="none" stroke="var(--color-light)" strokeWidth={1.2} strokeDasharray="4 4" opacity={0.5} vectorEffect="non-scaling-stroke" data-testid="light-future" />
      </Lane>
      <Lane label="Water" sub="tank · pump" nowPct={nowPct}>
        <polyline points={lanePoints(tankPts, tLo, tHi)} fill="none" stroke="var(--color-water)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" data-testid="tank-line" />
        <path d={laneTicks(pumpPast)} stroke="var(--color-pod-ok)" strokeWidth={3} vectorEffect="non-scaling-stroke" data-testid="pump-past" />
        <path d={laneTicks(pumpFuture)} stroke="var(--color-line-2)" strokeWidth={3} vectorEffect="non-scaling-stroke" data-testid="pump-future" />
      </Lane>
      <Lane label="Air" sub={`${aLo}–${aHi}°C`} nowPct={nowPct}>
        <polyline points={lanePoints(airPts, aLo, aHi)} fill="none" stroke="var(--color-fg)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" data-testid="air-line" />
      </Lane>

      <div className="grid grid-cols-[110px_minmax(0,1fr)] border-t border-line" role="group" aria-label="Events">
        <div className="py-3 text-sm">Events</div>
        <div ref={laneRef} className="relative h-16">
          <NowLine pct={nowPct} />
          {placed.map(e => (
            <div
              key={`${e.minute}-${e.label}`}
              className="absolute z-[1] flex -translate-x-1/2 flex-col items-center gap-1 bg-surface px-1"
              style={{ left: `${e.leftPct}%`, top: e.row === 0 ? 8 : 34 }}
              data-row={e.row}
            >
              <span className={cn('size-2 rotate-45', TONE[e.tone])} />
              <span className="whitespace-nowrap font-mono text-[10px] text-fg-2">{e.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[110px_minmax(0,1fr)]">
        <div />
        <div className="relative h-[18px] font-mono text-[10px] text-fg-3">
          {axis.filter(([pct]) => clear(pct)).map(([pct, t]) => (
            <span key={t} className={cn('absolute', pct > 0 && '-translate-x-1/2')} style={{ left: `${pct}%` }}>{t}</span>
          ))}
          <span className="absolute -translate-x-1/2 text-fg" style={{ left: `${nowPct}%` }}>now</span>
          {clear(100) && <span className="absolute right-0">24:00</span>}
        </div>
      </div>
    </section>
  )
}

/** Event labels stay short so two rows can hold a day. */
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 17).trimEnd()}…` : s)
