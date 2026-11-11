import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { Card } from '@/src/components/ds/core'
import { fmtClock } from '@/src/components/charts/format'
import { holdWindow, mergedAt, nextDim, nextOn, runningToday, type LightCurve } from '@/src/components/Light/curves'
import { fmtMinutes, nextRun, type PumpCycle } from '@/src/components/Water/pumpCycles'
import { fmtIn } from '@/src/components/System/statusData'
import { useNow } from '@/src/components/System/useNow'
import { dayOn } from '@/src/lib/days'
import { localTime, systemZone } from '@/src/scheduler/time'

const DAY = 1440
/** A level held this long is a step; shorter runs of one level are a ramp's rounding. */
const RAMP_MIN = 10
/** The narrowest a pump run is drawn, so a minute's run still shows. */
const MIN_PX = 6
const LANE_H = 22
const LABEL_W = 64
/** The now pill's width, "now 14:05" at 11 px, to keep it inside the axis at either end. */
const PILL_W = 72

export const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--tank-fill) 55%, transparent) 0 1px, transparent 1px 6px)',
}

/** A stretch of the day the light holds a level (`from === to`) or ramps between two. */
export interface Segment { start: number, end: number, from: number, to: number }

/**
 * The day's light as steps and ramps, from the highest of `curves` minute by
 * minute as the scheduler picks: a level held at least ten minutes is a step,
 * and the minutes between steps a ramp from the one before to the one after.
 * Dark steps are kept, so the next change can be found; they aren't drawn.
 */
export function lightSegments(curves: LightCurve[]): Segment[] {
  if (!curves.length) return []
  const levels = Array.from({ length: DAY }, (_, m) => mergedAt(curves, m))
  const runs: { start: number, end: number, level: number }[] = []
  for (let m = 0; m < DAY; m++) {
    const last = runs.at(-1)
    if (last && last.level === levels[m]) last.end = m + 1
    else runs.push({ start: m, end: m + 1, level: levels[m] as number })
  }
  const out: (Segment & { ramp: boolean })[] = []
  for (const r of runs) {
    const last = out.at(-1)
    if (r.end - r.start >= RAMP_MIN) out.push({ start: r.start, end: r.end, from: r.level, to: r.level, ramp: false })
    else if (last?.ramp) last.end = r.end
    else out.push({ start: r.start, end: r.end, from: 0, to: 0, ramp: true })
  }
  // A ramp runs from the step before it to the step after.
  return out.map(({ ramp, ...s }) => (ramp ? { ...s, from: levels[Math.max(0, s.start - 1)] as number, to: levels[Math.min(DAY - 1, s.end)] as number } : s))
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface Mark {
  start: number
  end: number
  label: string
  /** The tooltip and the screen reader's name: what it is and exactly when. */
  title: string
  kind: 'light' | 'water' | 'preview' | 'run' | 'hold'
  muted?: boolean
  from?: number
  to?: number
}

/** "08:00–08:10"; a run past midnight ends on the next day's clock, "23:55–00:10". */
const span = (a: number, b: number) => `${fmtClock(Math.round(a))}–${Math.round(b) === DAY ? '24:00' : fmtClock(Math.round(b) % DAY)}`
const pctOf = (m: number) => (Math.max(0, Math.min(DAY, m)) / DAY) * 100
const LIGHT_MIX = (level: number, muted?: boolean) => `color-mix(in srgb, var(${muted ? '--text-3' : '--accent-light'}) ${Math.round(15 + level * 0.55)}%, transparent)`

/** A light segment as its mark: a step with its level written in, a ramp as a gradient between the two. */
function lightMark(s: Segment, muted: boolean): Mark {
  const ramp = s.from !== s.to
  const level = ramp ? `${s.from}% → ${s.to}%` : `${s.from}%`
  return { start: s.start, end: s.end, label: ramp ? '' : `${s.from}%`, title: `Light ${level} · ${span(s.start, s.end)}${muted ? ' · not running today' : ''}`, kind: 'light', muted, from: s.from, to: s.to }
}

function runMark(minute: number, durationS: number, title: string, kind: Mark['kind'], muted?: boolean): Mark {
  return { start: minute, end: minute + durationS / 60, label: fmtMinutes(durationS), title: `${title} · ${span(minute, minute + durationS / 60)} · ${fmtMinutes(durationS)}`, kind, muted }
}

/** A mark past midnight, drawn to 24:00 with its tail from 00:00; the title keeps its true times. */
function clipToDay(m: Mark): Mark[] {
  return m.end > DAY ? [{ ...m, end: DAY }, { ...m, start: 0, end: m.end - DAY }] : [m]
}

export interface ScheduleTimelineProps {
  /** The page's own row: drawn first, and the one the header's next is about. */
  lead: 'light' | 'water'
  curves: LightCurve[]
  cycles: PumpCycle[]
  /** The unit's zone: the schedules run on its clock. */
  timezone?: string
  /** A hand holding the light: since when, until when, at what level. */
  hold?: { since: string, until: string, level: number } | null
  /** The pump running now. */
  pumpRun?: { since: string, remainingS: number | null } | null
  /** A preset on show before it's applied: its runs as a hatched row under the real ones. */
  preview?: { name: string, short: string, runs: number[], durationS: number } | null
}

/**
 * Today on the unit's clock, midnight to midnight, in the style of
 * sleepypod's Tonight card: a Light row of steps with their level written in
 * and ramps as gradients, a Water row of pump runs with their length, and
 * a preset's runs hatched under them while it's previewed. Schedules off or
 * not running today are muted; a manual hold is outlined and a run going now
 * ringed. A now line crosses the rows, the header says what's next, and each
 * mark has its exact times on hover, tap or focus.
 */
export function ScheduleTimeline({ lead, curves, cycles, timezone, hold, pumpRun, preview }: ScheduleTimelineProps) {
  const nowMs = useNow(30_000)
  const now = new Date(nowMs)
  const zone = timezone ?? systemZone()
  const lt = localTime(now, zone)
  const nowMin = lt.minute + now.getSeconds() / 60
  const weekday = lt.weekday
  // Somewhere else today, in minutes of the unit's day.
  const minuteOf = (iso: string) => nowMin + (Date.parse(iso) - nowMs) / 60_000

  const running = useMemo(() => runningToday(curves, weekday), [curves, weekday])
  // With nothing running today, the curves there are show muted.
  const lightMuted = running.length === 0
  const segments = useMemo(() => lightSegments(lightMuted ? curves : running), [curves, running, lightMuted])

  const lightMarks: Mark[] = segments.filter(s => s.from > 0 || s.to > 0).map(s => lightMark(s, lightMuted))
  const holding = hold && Date.parse(hold.until) > nowMs ? hold : null
  if (holding) {
    const { fromMin, untilMin } = holdWindow(holding.since, holding.until, now, zone)
    if (untilMin > fromMin) lightMarks.push({ start: fromMin, end: untilMin, label: `hold ${holding.level}%`, title: `Held by hand at ${holding.level}% · ${span(fromMin, untilMin)}`, kind: 'hold' })
  }
  const waterMarks: Mark[] = cycles.flatMap((c) => {
    const today = c.enabled && dayOn(c.days, weekday)
    return clipToDay(runMark(c.spec.minute, c.spec.durationS, `${c.name}${today ? '' : c.enabled ? ' · not today' : ' · off'}`, 'water', !today))
  })
  if (pumpRun) {
    const from = Math.max(0, minuteOf(pumpRun.since))
    const until = pumpRun.remainingS === null ? nowMin : nowMin + pumpRun.remainingS / 60
    waterMarks.push(...clipToDay({ start: from, end: Math.max(until, from + 1), label: 'now', title: `Watering now · since ${fmtClock(Math.round(from))}${pumpRun.remainingS === null ? '' : `, ${fmtMinutes(pumpRun.remainingS)} left`}`, kind: 'run' }))
  }
  const previewMarks = preview ? preview.runs.flatMap(m => clipToDay(runMark(m, preview.durationS, `Preview: ${preview.name}`, 'preview'))) : null

  // What's next, by the same helpers as the pages' strips and subtitles, so they all agree.
  const clock = (iso: string) => fmtClock(localTime(new Date(iso), zone).minute)
  let nextLine: string | null = null
  if (lead === 'water') {
    const next = nextRun(cycles, now, zone)
    const inMin = next ? (next.at.getTime() - nowMs) / 60_000 : 0
    if (next) nextLine = `next · Watering ${fmtMinutes(next.cycle.spec.durationS)} ${inMin < DAY ? fmtIn(inMin) : `${WEEKDAYS[localTime(next.at, zone).weekday]} ${fmtClock(next.cycle.spec.minute)}`}`
  }
  else if (holding) {
    nextLine = `next · Held at ${holding.level}% until ${clock(holding.until)}`
  }
  else if (mergedAt(running, Math.floor(nowMin)) > 0) {
    const dims = nextDim(running, nowMin)
    if (dims !== null) nextLine = `next · Lights dim at ${fmtClock(dims)}`
  }
  else {
    const on = nextOn(running, runningToday(curves, (weekday + 1) % 7), nowMin)
    if (on) nextLine = `next · Lights on ${on.tomorrow ? 'tomorrow' : 'at'} ${fmtClock(on.minute)}`
  }

  // The lanes are measured so runs keep a visible width, labels fit, and hours thin out on a phone.
  const [lane, setLane] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!lane || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(lane.clientWidth || 800))
    ro.observe(lane)
    return () => ro.disconnect()
  }, [lane])
  const [active, setActive] = useState<string | null>(null)
  // Safari doesn't focus a tapped button, so a tap's tooltip closes on a tap anywhere but a mark.
  const group = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active === null) return
    const close = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest('[data-timeline-mark]') && group.current?.contains(e.target))) setActive(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [active])

  const rows = [
    { id: 'light', name: 'Light', marks: lightMarks },
    { id: 'water', name: 'Water', marks: waterMarks },
  ]
  if (lead === 'water') rows.reverse()
  if (previewMarks && preview) rows.splice(rows.findIndex(r => r.id === 'water') + 1, 0, { id: 'preview', name: 'Preview', marks: previewMarks })

  const step = width < 420 ? 6 : 3
  const ticks = Array.from({ length: DAY / 60 / step + 1 }, (_, i) => i * step * 60)
  const nowPct = pctOf(nowMin)
  // An hour label gives way to the now pill when they'd touch: by their centres, the end labels sitting inside the axis.
  const clear = (m: number) => Math.abs((pctOf(m) - nowPct) / 100 * width + (m === 0 ? 18 : m === DAY ? -18 : 0)) > 58
  const muted = [...lightMarks, ...waterMarks].some(m => m.muted)

  const describe = (marks: Mark[], none: string) => (marks.length ? marks.map(m => m.title).join('; ') : none)
  const summary = `Today on the unit's clock, now ${fmtClock(Math.floor(nowMin))}. ${rows.map(r => `${r.name}: ${describe(r.marks, r.id === 'light' ? 'no light scheduled' : 'no pump runs')}`).join('. ')}.`

  return (
    <Card className="gap-3" data-testid="schedule-timeline">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-medium">Today</span>
        {nextLine && <span className="font-mono text-xs text-fg-2" data-testid="timeline-next">{nextLine}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-2">
          {muted && (
            <span className="flex items-center gap-1.5" data-testid="legend-muted">
              <span className="h-2 w-3.5 rounded-[2px] bg-fg-3/40" />
              off or not today
            </span>
          )}
          {hold && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3.5 rounded-[2px] border border-hold bg-hold/25" />
              manual hold
            </span>
          )}
          {preview && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3.5 rounded-[2px] border border-dashed border-tank/70" style={HATCH} />
              preview
            </span>
          )}
        </div>
      </div>

      <div ref={group} role="group" aria-label={summary} className="relative grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
        {/* The hour grid, under the lanes and their marks. */}
        <div aria-hidden className="pointer-events-none absolute top-0 right-0 bottom-5" style={{ left: LABEL_W + 8 }}>
          {ticks.map(t => <span key={t} className="absolute inset-y-0 w-px bg-grid" style={{ left: `${pctOf(t)}%` }} />)}
        </div>
        {rows.map((r, i) => (
          <Row key={r.id} id={r.id} name={r.name} sub={r.id === 'preview' ? preview?.short : undefined} title={r.id === 'preview' ? `Preview: ${preview?.name ?? ''}` : undefined} marks={r.marks} width={width} active={active} onActive={setActive} laneRef={i === 0 ? setLane : undefined} />
        ))}

        <span />
        <div className="relative h-5 font-mono text-[11px] text-fg-3" aria-hidden>
          {ticks.filter(clear).map(t => (
            <span key={t} className={cn('absolute top-1 whitespace-nowrap', t === 0 ? '' : t === DAY ? '-translate-x-full' : '-translate-x-1/2')} style={{ left: `${pctOf(t)}%` }}>
              {t === DAY ? '24:00' : fmtClock(t)}
            </span>
          ))}
          <span className="absolute top-0.5 whitespace-nowrap rounded-tag bg-fg px-1.5 text-inverse" style={{ left: Math.max(0, Math.min(width - PILL_W, (nowPct / 100) * width - PILL_W / 2)) }} data-testid="timeline-now-label">
            {`now ${fmtClock(Math.floor(nowMin))}`}
          </span>
        </div>

        {/* The now line across every lane, over the marks. */}
        <div aria-hidden className="pointer-events-none absolute top-0 right-0 bottom-5 z-[2]" style={{ left: LABEL_W + 8 }}>
          <span className="absolute inset-y-0 w-px bg-fg" style={{ left: `${nowPct}%` }} data-testid="timeline-now" />
        </div>
      </div>
    </Card>
  )
}

function Row({ id, name, sub, title, marks, width, active, onActive, laneRef }: {
  id: string
  name: string
  sub?: string
  title?: string
  marks: Mark[]
  width: number
  active: string | null
  onActive: (key: string | null) => void
  laneRef?: (el: HTMLDivElement | null) => void
}) {
  const pxPerMin = width / DAY
  // By time, and today's runs over the muted ones where they meet.
  const sorted = [...marks].sort((a, b) => a.start - b.start || Number(!!b.muted) - Number(!!a.muted))
  const open = sorted.find((m, i) => `${id}-${i}` === active)
  // The tooltip as wide as its text (wrapping past the lane and its label column), kept inside them.
  const tipMax = width + LABEL_W + 8
  const tipW = open ? Math.min(open.title.length * 6.7 + 14, tipMax) : 0
  const tipLeft = open ? Math.max(-(LABEL_W + 8), Math.min(width - tipW, ((open.start + open.end) / 2) * pxPerMin - tipW / 2)) : 0
  return (
    <>
      <div className="flex min-w-0 flex-col leading-tight" title={title}>
        <span className="truncate text-[13px]">{name}</span>
        {sub && <span className="truncate font-mono text-[11px] text-fg-3">{sub}</span>}
      </div>
      <div ref={laneRef} className={cn('relative rounded-[2px] bg-active/60', id === 'preview' && 'border border-dashed border-tank/40')} style={{ height: LANE_H }} data-testid={`lane-${id}`}>
        {sorted.map((m, i) => {
          const key = `${id}-${i}`
          const run = m.kind !== 'light' && m.kind !== 'hold'
          // A run is as wide as its length, or its label if the gap to the next run allows, and never under MIN_PX.
          // A run at the same minute doesn't count as the next: the one on top keeps its label.
          const next = sorted.slice(i + 1).find(n => n.kind === m.kind && n.start > m.start)
          const gapPx = next ? (next.start - m.start) * pxPerMin - 2 : (DAY - m.start) * pxPerMin
          const labelPx = m.label.length * 7.4 + 12
          const lengthPx = (m.end - m.start) * pxPerMin
          const widthPx = run ? Math.min(Math.max(lengthPx, Math.min(labelPx, gapPx), MIN_PX), width) : lengthPx
          const fits = widthPx >= labelPx
          // Kept inside the lane at 24:00.
          const leftPx = Math.min(m.start * pxPerMin, width - widthPx)
          return (
            <button
              key={key}
              type="button"
              aria-label={m.title}
              aria-describedby={active === key ? `${key}-tip` : undefined}
              data-testid={`mark-${id}`}
              data-kind={m.kind}
              data-muted={m.muted ? 'true' : undefined}
              data-timeline-mark=""
              // A mouse shows the times while over a mark; a tap or focus until another mark, a blur or Escape.
              onPointerEnter={e => e.pointerType === 'mouse' && onActive(key)}
              onPointerLeave={e => e.pointerType === 'mouse' && onActive(null)}
              onFocus={() => onActive(key)}
              onBlur={() => onActive(null)}
              onClick={() => onActive(key)}
              onKeyDown={e => e.key === 'Escape' && onActive(null)}
              className={cn(
                'absolute inset-y-0 cursor-default overflow-hidden whitespace-nowrap rounded-[2px] px-1 text-left font-mono text-[11px] leading-[22px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-fg',
                m.kind === 'water' && (m.muted ? 'bg-fg-3/40 text-fg-2' : 'z-[1] bg-tank/60'),
                m.kind === 'run' && 'z-[1] bg-tank ring-2 ring-tank/50 text-inverse motion-safe:animate-pulse',
                m.kind === 'preview' && 'border border-dashed border-tank/70 text-fg-2',
                m.kind === 'hold' && 'z-[1] border border-hold bg-hold/25 leading-5',
                m.kind === 'light' && m.muted && 'text-fg-2',
              )}
              style={{
                left: `${(leftPx / (width || 1)) * 100}%`,
                width: `${(widthPx / (width || 1)) * 100}%`,
                ...(m.kind === 'preview' ? HATCH : {}),
                ...(m.kind === 'light' ? { background: m.from === m.to ? LIGHT_MIX(m.from ?? 0, m.muted) : `linear-gradient(to right, ${LIGHT_MIX(m.from ?? 0, m.muted)}, ${LIGHT_MIX(m.to ?? 0, m.muted)})` } : {}),
              }}
            >
              <span className={cn(!fits && 'invisible')}>{m.label}</span>
            </button>
          )
        })}
        {open && (
          <span
            role="tooltip"
            id={`${id}-${sorted.indexOf(open)}-tip`}
            data-testid="timeline-tip"
            className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-tag border border-line-2 bg-surface px-1.5 py-0.5 font-mono text-[11px] text-fg"
            style={{ left: tipLeft, width: tipW }}
          >
            {open.title}
          </span>
        )}
      </div>
    </>
  )
}
