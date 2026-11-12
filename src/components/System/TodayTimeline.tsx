import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { describeAlert } from '@/src/components/Alerts/AlertsPage'
import { asCurve, runningToday } from '@/src/components/Light/curves'
import { asCycle } from '@/src/components/Water/pumpCycles'
import type { SensorId } from '@/src/hardware/contract'
import { dayOn, weekdayOf } from '@/src/lib/days'
import { Chart3D, ChartNote, LoadingLine, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { todayData } from '@/src/components/charts/viz3d/shape'
import { trpc } from '@/src/utils/trpc'
import { useNow } from './useNow'
import {
  burstStarts, eventRows, fmtIn, isToday, laneArea, lanePoints, laneTicks, lightSeries, mergeCurves, minuteOfDay, nextJob, niceRange, todaySamples,
  type EventRow, type EventTone, type LaneEvent,
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
  return { curves, cycles, curve, setpoints, jobs: curves.length + cycles.length, schedules, previews }
}

const TONE: Record<EventTone, string> = { muted: 'bg-fg-3', light: 'bg-light', down: 'bg-pod-attention', pump: 'bg-pod-ok', planned: 'bg-line-2' }

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
  // An alert spans the time it was raised: to now while it still is, to when it cleared once it has; dismissed by hand, just its start.
  const raisedUntil = (a: { active: boolean, clearedAt?: string | null }) => (a.active ? nowMin : a.clearedAt ? (fromToday(a.clearedAt) ? minuteOf(a.clearedAt) : 1440) : undefined)
  const rows = eventRows([
    ...pumpPast.map(minute => ({ minute, label: 'Pump', tone: 'pump' as const })),
    ...pumpFuture.map(minute => ({ minute, label: 'Pump', tone: 'planned' as const })),
    ...(backup.data?.recent ?? []).filter(b => b.ok && fromToday(b.ts)).map(b => ({ minute: minuteOf(b.ts), label: 'Backup', tone: 'muted' as const })),
    ...burstStarts((autoRuns.data ?? []).filter(r => r.outcome === 'fired' && fromToday(r.firedAt)).map(r => ({ key: r.automationId, minute: minuteOf(r.firedAt) })))
      .map(r => ({ minute: r.minute, label: short(ruleName.get(r.key as number) ?? 'Autopilot'), tone: 'light' as const })),
    ...(alerts.data ?? []).filter(a => fromToday(a.raisedAt)).map(a => ({ minute: minuteOf(a.raisedAt), until: raisedUntil(a), label: short(describeAlert(a).title), tone: a.kind.startsWith('reminder_') ? 'muted' as const : 'down' as const })),
  ])

  // The light lane is drawn from the curves' previews, so the chart waits for those too.
  const queries = [today.schedules, light, tank, air, ...today.previews]
  const status = vizStatus(queries, false)
  const loading = status === 'loading'
  const scene = status === 'ready'
    ? todayData({ nowMin, light: lightLane, tank: tankPts, tankRange: [tLo, tHi], air: airPts, airRange: [aLo, aHi] })
    : null

  const flat = (
    <>
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

    </>
  )

  return (
    <section aria-label="Today" className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface px-[22px] pb-3.5 pt-[18px]">
      <div className="flex flex-wrap items-baseline gap-3 pb-2.5">
        <h2 className="text-[15px] font-semibold">Today</h2>
        <div className="min-w-[220px] flex-1 font-mono text-xs text-fg-3">
          {loading ? <LoadingLine /> : next ? `next: ${next.label} · ${fmtIn(next.minute - nowMin)}` : 'nothing else scheduled today'}
        </div>
        <ChartNote status={status} stale={staleSince(queries)} onRetry={() => queries.forEach(q => void q.refetch?.())} />
        <Link to="/light" className="flex items-center gap-1.5 text-[13px] text-fg-2 hover:text-fg">
          <span className="font-mono">{today.jobs}</span>
          {` job${today.jobs === 1 ? '' : 's'} · Schedule`}
          <ArrowRight size={16} />
        </Link>
      </div>
      <Chart3D kind="today" data={scene} status={status} label="Today: light, water and air from midnight" message="Couldn't load today's readings." fallback={flat} />
      <EventStrip rows={rows} nowPct={nowPct} />
    </section>
  )
}

const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m) % 60).padStart(2, '0')}`
const when = (e: LaneEvent) => (e.until !== undefined && e.until - e.minute >= 1 ? `${clock(e.minute)}–${clock(e.until)}` : clock(e.minute))

/**
 * The day's events under the chart, flat in both its 3D and flat forms: a row
 * per kind with a mark at each time it happened, an alert as a bar for as
 * long as it was raised, and pump runs still to come greyed.
 */
function EventStrip({ rows, nowPct }: { rows: EventRow[], nowPct: number }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(box.clientWidth || 800))
    ro.observe(box)
    return () => ro.disconnect()
  }, [box])
  const axis = [[0, '00:00'], [25, '06:00'], [50, '12:00'], [75, '18:00']] as const
  // An hour label gives way to "now" when they'd touch.
  const clear = (pct: number) => (Math.abs(pct - nowPct) / 100) * width > 40
  return (
    <div role="group" aria-label="Events" className="flex flex-col">
      {rows.length === 0 && (
        <div className="grid grid-cols-[110px_minmax(0,1fr)] border-t border-line py-2.5">
          <div className="text-sm">Events</div>
          <div className="text-[12px] text-fg-3">Nothing yet today</div>
        </div>
      )}
      {rows.map((r, i) => {
        const done = r.marks.filter(m => m.tone !== 'planned')
        const first = done[0]
        const last = done.at(-1)
        const summary = done.length === 0 ? 'still to come' : `${done.length} ${done.length === 1 ? 'time' : 'times'}, ${first && clock(first.minute)}${last && last !== first ? ` to ${clock(last.minute)}` : ''}`
        return (
          <div key={r.label} className={cn('grid grid-cols-[110px_minmax(0,1fr)] items-center', i === 0 && 'border-t border-line pt-1.5')} role="group" aria-label={`${r.label}: ${summary}`} data-testid="event-row">
            <div className="flex min-w-0 items-baseline gap-1.5 py-1">
              <span className="truncate text-[12px] text-fg-2">{r.label}</span>
              {done.length > 1 && <span className="font-mono text-[10px] text-fg-3">{`×${done.length}`}</span>}
            </div>
            <div ref={i === 0 ? setBox : undefined} className="relative h-5">
              <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
              {r.marks.map(m => (
                <span
                  key={`${m.minute}-${m.until ?? ''}-${m.tone}`}
                  title={`${r.label} · ${when(m)}`}
                  data-testid="event-mark"
                  className={cn('absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[1px]', TONE[m.tone], m.until === undefined ? 'w-[3px] -translate-x-1/2' : 'min-w-[3px] opacity-80')}
                  style={{ left: `${(m.minute / 1440) * 100}%`, ...(m.until !== undefined && { width: `${((m.until - m.minute) / 1440) * 100}%` }) }}
                />
              ))}
              <NowLine pct={nowPct} />
            </div>
          </div>
        )
      })}
      <div className="grid grid-cols-[110px_minmax(0,1fr)] pt-1">
        <div />
        <div className="relative h-[18px] font-mono text-[10px] text-fg-3">
          {axis.filter(([pct]) => clear(pct)).map(([pct, t]) => (
            <span key={t} className={cn('absolute', pct > 0 && '-translate-x-1/2')} style={{ left: `${pct}%` }}>{t}</span>
          ))}
          <span className="absolute -translate-x-1/2 text-fg" style={{ left: `${nowPct}%` }}>now</span>
          {clear(100) && <span className="absolute right-0">24:00</span>}
        </div>
      </div>
    </div>
  )
}

/** Event labels stay short so they fit the row's name column. */
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 17).trimEnd()}…` : s)
