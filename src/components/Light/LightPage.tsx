import { ChevronDown, ChevronUp, Clock, Hand, Plus, Sun } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, GhostIcon } from '@/src/components/ds/core'
import { Slider, Toggle } from '@/src/components/ds/forms'
import { LineChart } from '@/src/components/ds/charts'
import { ScheduleTimeline } from '@/src/components/charts/ScheduleTimeline'
import { fmtClock } from '@/src/components/charts/format'
import { Chart3D, ChartNote, LoadingLine, Pending, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { lightData } from '@/src/components/charts/viz3d/shape'
import { daysLabel } from '@/src/lib/days'
import { GARDYN_LIGHT_GUIDE, LIGHT_PRESETS, lightHours, lightRating, LONG_DAY_HOURS } from '@/src/scheduler/lightPlan'
import { localTime, systemZone, zoneAbbr } from '@/src/scheduler/time'
import { trpc } from '@/src/utils/trpc'
import { asCycle } from '@/src/components/Water/pumpCycles'
import { unitPlace, type Place } from '@/src/scheduler/place'
import type { SunDay } from '@/src/scheduler/sun'
import { CurveEditor } from './CurveEditor'
import { useLightControl } from './useLightControl'
import { asCurve, holdWindow, levelAt, lightToday, nextDim, nextOn, runningToday, SAMPLE_MINUTES, sunToday, todayLevels, type LightCurve } from './curves'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
const AXIS = 'flex justify-between font-mono text-[10px] text-fg-3'
/** Gardyn's ratings: Great is the aim; Low and Too much want hours added or taken away. */
const RATING_TONE: Record<ReturnType<typeof lightRating>, string> = { 'low': 'bg-pod-attention/15 text-pod-attention', 'ok': 'bg-pod-ready/15 text-pod-ready', 'great': 'bg-pod-ok/15 text-pod-ok', 'intense': 'bg-pod-ready/15 text-pod-ready', 'too much': 'bg-pod-attention/15 text-pod-attention' }
/** A moment as the unit's clock reads it. */
const clock = (iso: string, zone: string) => fmtClock(localTime(new Date(iso), zone).minute)

export function LightPage() {
  const { light: l, query: lightQuery, level, requested, lightOn, preview, commit, power } = useLightControl()
  const schedules = trpc.schedules.list.useQuery()
  const utils = trpc.useUtils()
  const owner = trpc.light.owner.useQuery(undefined, { refetchInterval: 15_000 })
  const resume = trpc.light.resume.useMutation({ onSuccess: () => utils.light.invalidate() })
  const o = owner.data
  const upsert = trpc.schedules.upsert.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const setAuto = trpc.schedules.setAuto.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const lightHours = trpc.telemetry.lightHours.useQuery()
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const settings = trpc.settings.get.useQuery()
  const timezone = settings.data?.timezone
  // Auto's curve leads the list.
  const curves = useMemo(() => (schedules.data ?? []).flatMap(s => asCurve(s) ?? []).sort((a, b) => Number(!!b.spec.sun?.auto) - Number(!!a.spec.sun?.auto)), [schedules.data])
  const autoOn = curves.some(c => c.spec.sun?.auto && c.enabled)
  const now = new Date()
  // Curves run on the unit's clock, so today and now are its, not this browser's.
  const zone = timezone ?? systemZone()
  const { minute: minutesNow, weekday } = localTime(now, zone)
  // Each weekday's hours of light, once per set of curves, not on every slider move.
  const hoursByDay = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const today = runningToday(curves, d)
    return today.length ? lightToday(today) : null
  }), [curves])
  const hours = hoursByDay[weekday] ?? null
  const running = runningToday(curves, weekday)
  const sun = sunToday(running, settings.data ?? {}, zone, now)
  const today = todayLevels(running)
  // With nothing picked, the first curve running today is the open one.
  const open = openId ?? running[0]?.id ?? null
  const nowAt = minutesNow / 15
  const queries = [schedules, lightQuery]
  const status = vizStatus(queries, today === null)
  const scene = status === 'ready' && today
    ? lightData({ planned: today, nowMin: minutesNow + now.getSeconds() / 60, level: l?.on ? l.level : 0, hold: o?.source === 'manual' && o.manualUntil && l ? holdWindow(l.since, o.manualUntil, now, zone) : null })
    : null

  const following = running.length === 1 ? `Following ${running[0]?.name}` : running.length > 1 ? `Following ${running.length} curves` : 'No curve today'
  const holding = o?.source === 'manual' && o.manualUntil ? `held by hand until ${clock(o.manualUntil, zone)}` : o?.source === 'autopilot' ? 'Autopilot is in charge' : null
  const rating = hours === null ? null : lightRating(hours.full)

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Light</h1>
        <p className="text-[13px] text-fg-2">{[following, holding].filter(Boolean).join(' · ')}</p>
      </div>

      <Card className="@container gap-0 overflow-hidden p-0">
        <LightStrip
          on={lightOn}
          known={!!l}
          owner={o}
          running={running}
          curves={curves}
          minute={minutesNow}
          weekday={weekday}
          zone={zone}
          // Off reads as the slider at 0, unless a level has just been asked for.
          level={lightOn || requested ? level : 0}
          auto={autoOn}
          sun={sun}
          place={unitPlace({ ...settings.data, timezone: zone })}
          onAuto={on => setAuto.mutate({ on })}
          resuming={resume.isPending}
          onResume={() => resume.mutate()}
          onPower={power}
          onPreview={preview}
          onCommit={commit}
        />
        <div className="flex flex-col gap-3 px-[22px] pb-5 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-mono text-[44px] font-medium leading-none" data-testid="light-level"><Pending loading={!l} sample="100%">{l && (l.on || requested ? `${level}%` : 'Off')}</Pending></span>
              <span className="min-h-[18px] text-[12px] text-fg-3" data-testid="light-summary">
                {schedules.data === undefined ? <LoadingLine /> : hours === null || rating === null ? 'Nothing scheduled today' : [`${hours.full} h of full light today`, `${rating.charAt(0).toUpperCase()}${rating.slice(1)}`, hours.lit > LONG_DAY_HOURS && `on ${hours.lit} h, ${LONG_DAY}`].filter(Boolean).join(' · ')}
              </span>
            </div>
            <ChartNote status={status} stale={staleSince(queries)} onRetry={() => queries.forEach(q => void q.refetch())} />
          </div>
          <Chart3D
            kind="light"
            data={scene}
            status={status}
            label={`Today's light: the curve planned, what the LED has given so far${o?.source === 'manual' ? ', and the manual hold' : ''}, beside the lamp now`}
            message={status === 'error' ? 'Couldn\'t load today\'s curve.' : 'No curve runs today, so the light stays where you set it.'}
            fallback={today
              ? (
                  <>
                    <LineChart
                      height={110}
                      min={0}
                      max={100}
                      series={[
                        { data: today, color: 'var(--meter)', fill: true, width: 1.5 },
                        // Where the light actually is now, on the curve's timeline.
                        { data: SAMPLE_MINUTES.map((_, i) => (l && i === Math.round(nowAt) ? (l.on ? l.level : 0) : Number.NaN)), color: 'var(--pod-ok)', dots: true, width: 4 },
                      ]}
                      markers={[{ at: nowAt, label: `now ${fmtClock(minutesNow)} ${zoneAbbr(now, zone)}` }]}
                      xLabel={i => fmtClock(SAMPLE_MINUTES[i] ?? 0)}
                      format={(v, s) => (s === 0 ? `curve ${Math.round(v)}%` : `now ${Math.round(v)}%`)}
                    />
                    <div className={AXIS} aria-hidden>
                      <span>00:00</span>
                      <span>06:00</span>
                      <span>12:00</span>
                      <span>18:00</span>
                      <span>24:00</span>
                    </div>
                  </>
                )
              : <p className="py-6 text-center text-[13px] text-fg-3">No curve runs today, so the light stays where you set it.</p>}
          />
        </div>
      </Card>
      {lightHours.data && (
        <p className="-mt-3 font-mono text-[11px] text-fg-3" data-testid="led-hours">{`LED life ${Math.round(Math.max(0, 100 - lightHours.data.pctUsed))}% · ${Math.round(lightHours.data.hours).toLocaleString()} / ${lightHours.data.ratedHours.toLocaleString()} h`}</p>
      )}

      <ScheduleTimeline
        lead="light"
        curves={curves}
        cycles={(schedules.data ?? []).flatMap(s => asCycle(s) ?? [])}
        timezone={timezone}
        hold={o?.source === 'manual' && o.manualUntil && l ? { since: l.since, until: o.manualUntil, level: l.on ? l.level : 0 } : null}
        sun={sun}
      />

      <div className="flex items-center gap-3">
        <h2 className={`${EYEBROW} flex-1`}>Curves</h2>
        <Button icon={Plus} aria-expanded={adding || curves.length === 0} onClick={() => setAdding(!adding)}>Add curve</Button>
      </div>
      {timezone === 'UTC' && (
        <p className="flex items-center gap-2 text-[13px] text-warn" data-testid="utc-warning">
          <Clock size={16} className="shrink-0" />
          <span>
            {'Curves run on the unit’s clock, which is set to UTC. '}
            <Link to="/settings" hash="unit" className="underline underline-offset-2">Set your timezone</Link>
            {' so 6 AM means your morning.'}
          </span>
        </p>
      )}
      {(adding || curves.length === 0) && (
        <Card dashed className="gap-3">
          <p className="text-[13px] text-fg-2 text-pretty">
            {'Gardyn recommends 14–16 hours a day at full brightness (Boost); 17 or more stress the plants, and nights need unbroken dark. Dimmed hours count here in part: two hours at 50% are one of full light. '}
            <a href={GARDYN_LIGHT_GUIDE} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">Gardyn’s guide</a>
            {curves.length === 0 ? '. Start from one of these:' : '. Start from:'}
          </p>
          <div className="grid gap-2 min-[720px]:grid-cols-3">
            {LIGHT_PRESETS.map(p => (
              <button
                key={p.id}
                type="button"
                data-testid={`preset-${p.id}`}
                onClick={() => {
                  const id = `curve-${Date.now().toString(36)}`
                  // The first curve runs straight away; another starts off, since enabled curves stack.
                  upsert.mutate({ id, kind: 'light', name: p.name, enabled: curves.length === 0, days: 127, spec: { setpoints: p.setpoints } })
                  setAdding(false)
                  setOpenId(id)
                }}
                className="flex cursor-pointer flex-col gap-1 rounded-card border border-line bg-surface px-3.5 py-3 text-left hover:border-line-2"
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-[12px] leading-snug text-fg-2">{p.description}</span>
              </button>
            ))}
            <button
              type="button"
              data-testid="preset-blank"
              onClick={() => {
                const id = `curve-${Date.now().toString(36)}`
                upsert.mutate({ id, kind: 'light', name: 'New curve', enabled: false, days: 127, spec: { setpoints: [{ minute: 420, level: 0 }, { minute: 480, level: 80 }, { minute: 1200, level: 80 }, { minute: 1260, level: 0 }] } })
                setAdding(false)
                setOpenId(id)
              }}
              className="flex cursor-pointer flex-col gap-1 rounded-card border border-dashed border-line-2 px-3.5 py-3 text-left hover:border-fg-3"
            >
              <span className="text-sm font-medium">Blank</span>
              <span className="text-[12px] leading-snug text-fg-2">Your own setpoints by time of day; brightness ramps between them.</span>
            </button>
          </div>
        </Card>
      )}
      {curves.map(c => (
        <CurveCard
          key={c.id}
          curve={c}
          running={running.includes(c)}
          open={open === c.id}
          locked={autoOn && !c.spec.sun?.auto}
          onOpen={next => setOpenId(next ? c.id : '')}
          // Auto's own switch is the strip's: on, it runs alone; off, the curves it stopped come back.
          onSave={next => (c.spec.sun?.auto && next.enabled !== c.enabled ? setAuto.mutate({ on: next.enabled }) : upsert.mutate(next))}
        />
      ))}
    </div>
  )
}

type Owner = { source: 'manual' | 'autopilot' | 'schedule' | null, manualUntil: string | null, schedule: number | null } | undefined

/**
 * The top band of the Light card, the Water strip's twin: what the light is
 * doing and why (the curve it follows and when it next dims or comes on, a
 * hand's hold with Resume, or Autopilot), with power and brightness at the
 * right. It tints amber while the light is on. A change here holds for 30
 * minutes, as before.
 */
function LightStrip({ on, known, owner: o, running, curves, minute, weekday, zone, level, auto, sun, place, onAuto, resuming, onResume, onPower, onPreview, onCommit }: {
  on: boolean
  known: boolean
  owner: Owner
  running: LightCurve[]
  /** Every light curve, for tomorrow's. */
  curves: LightCurve[]
  /** Now on the unit's clock. */
  minute: number
  weekday: number
  zone: string
  level: number
  /** Whether Auto runs the light, and switching it. */
  auto: boolean
  /** Today's sun, when a curve follows it; and where the unit sees it from, set or guessed from its timezone. */
  sun: SunDay | null
  place: Place | null
  onAuto: (on: boolean) => void
  resuming: boolean
  onResume: () => void
  onPower: (on: boolean) => void
  onPreview: (level: number) => void
  onCommit: (level: number) => void
}) {
  // Scanning the day's minutes runs once per minute and set of curves, not on every render (a drag renders many).
  const dims = useMemo(() => nextDim(runningToday(curves, weekday), minute), [curves, weekday, minute])
  const next = useMemo(() => nextOn(runningToday(curves, weekday), runningToday(curves, (weekday + 1) % 7), minute), [curves, weekday, minute])
  const held = o?.source === 'manual' && o.manualUntil
  const following = running.length === 1 ? running[0]?.name : running.length > 1 ? `${running.length} curves` : null
  let title = known ? `${auto ? 'Auto · ' : ''}${on ? 'Light on' : 'Light off'}` : 'Light'
  let sub: ReactNode = null
  if (held) {
    title = `Held by hand until ${clock(o.manualUntil ?? '', zone)}`
    sub = (
      <>
        <span className="truncate">{`then ${o.schedule !== null ? `the curve (${o.schedule}% at this hour)` : 'the curve or Autopilot'}`}</span>
        <button type="button" disabled={resuming} onClick={onResume} className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-fg underline underline-offset-2 disabled:opacity-60">Resume schedule</button>
      </>
    )
  }
  else if (o?.source === 'autopilot') {
    sub = <span className="truncate">Autopilot is setting the light</span>
  }
  else if (auto) {
    // What Auto made of today: when the light comes up and goes off, from sunrise and sunset.
    const curve = running.find(c => c.spec.sun?.auto)
    const pts = curve ? [...curve.spec.setpoints].sort((a, b) => a.minute - b.minute) : []
    const up = pts.find(p => p.level === 0 && pts.some(q => q.minute > p.minute && q.level > 0))
    const off = [...pts].reverse().find(p => p.level === 0 && pts.some(q => q.minute < p.minute && q.level > 0))
    sub = (
      <span className="truncate" data-testid="auto-sub">
        {place && sun
          ? [`sunrise ${sun.sunrise === null ? '–' : fmtClock(sun.sunrise)}`, `sunset ${sun.sunset === null ? '–' : fmtClock(sun.sunset)}`, up && off ? `light ${fmtClock(up.minute)}–${fmtClock(off.minute)}` : null, place.source === 'timezone' ? `near ${place.city}` : null].filter(Boolean).join(' · ')
          : (
              <>
                {'centred on 12:00 · '}
                <Link to="/settings" hash="unit" className="text-fg underline underline-offset-2">set a location</Link>
                {' to follow the sun'}
              </>
            )}
      </span>
    )
  }
  else if (on) {
    sub = <span className="truncate">{following ? [`following ${following}`, dims !== null ? `dims at ${fmtClock(dims)}` : null].filter(Boolean).join(' · ') : 'no curve today'}</span>
  }
  else if (known) {
    sub = <span className="truncate">{next ? `Next on ${next.tomorrow ? 'tomorrow ' : ''}${fmtClock(next.minute)} (${next.name})` : 'no curve to turn it on'}</span>
  }
  return (
    <div
      data-testid="light-strip"
      data-state={on ? 'on' : 'off'}
      data-auto={auto ? 'true' : undefined}
      className={cn('flex flex-col gap-3 border-b border-line px-[22px] py-3.5 @min-[620px]:flex-row @min-[620px]:items-center @min-[620px]:justify-between', on ? 'bg-light/10' : 'bg-active/40', auto && !held && 'light-auto')}
    >
      <div className="flex h-11 min-w-0 items-center gap-3">
        {held ? <Hand size={14} className="shrink-0 text-light" /> : auto ? <Sun size={16} className={cn('light-auto-sun shrink-0', on ? 'text-light' : 'text-fg-3')} aria-hidden /> : <span className={cn('size-2.5 shrink-0 rounded-full', on ? 'bg-light' : 'bg-fg-3')} />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-medium leading-tight">{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3">{sub}</span>
        </div>
      </div>
      <div className="flex h-10 items-center gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-2">
          <Toggle on={auto} size="md" label="Auto" onChange={onAuto} />
          Auto
        </label>
        {/* One slider for both: all the way down is off. */}
        <div className="flex items-center gap-2.5" title={auto ? 'Auto sets the brightness from sunrise and sunset. Turn Auto off to set it by hand.' : 'A change here holds for 30 minutes, then the curve or Autopilot takes over again.'}>
          <div className="w-[200px] max-w-[40vw]">
            <Slider value={level} step={5} disabled={auto} marks={[25, 50, 75]} onChange={onPreview} onCommit={v => (v === 0 ? onPower(false) : onCommit(v))} label="Brightness" />
          </div>
          <span className="w-9 text-right font-mono text-[12px] text-fg-2" data-testid="strip-level">{level > 0 ? `${level}%` : 'Off'}</span>
        </div>
      </div>
    </div>
  )
}

/** A caution once the light is on long enough, however dim, to make lettuce and herbs bolt. */
const LONG_DAY = 'long enough to make lettuce and herbs bolt'

function CurveCard({ curve: c, running, open, locked, onOpen, onSave }: { curve: LightCurve, running: boolean, open: boolean, /** Auto is on, so this curve waits. */ locked: boolean, onOpen: (open: boolean) => void, onSave: (next: LightCurve) => void }) {
  const n = c.spec.setpoints.length
  const hours = lightHours(c.spec)
  const meta = [c.spec.sun?.auto ? 'Auto · follows the sun' : c.spec.sun ? 'Follows the sun' : `${n} setpoint${n === 1 ? '' : 's'}`, daysLabel(c.days), c.enabled ? `on ${hours.lit} h, ${hours.full} h of full light` : 'off', c.enabled && hours.lit > LONG_DAY_HOURS && LONG_DAY, locked && 'waiting while Auto runs'].filter(Boolean).join(' · ')
  const rating = lightRating(hours.full)
  return (
    <Card className="gap-0 p-0">
      <div className="flex flex-wrap items-center gap-4 px-5 py-[18px]">
        <button type="button" className="flex min-w-[200px] flex-1 cursor-pointer flex-col gap-[3px] text-left" onClick={() => onOpen(!open)}>
          <span className="flex items-center gap-2">
            <span className={c.enabled ? 'text-[15px] font-medium' : 'text-[15px] font-medium text-fg-2'}>{c.name}</span>
            {running && <Badge variant="active" />}
            <span data-testid={`rating-${c.id}`} className={cn('rounded-[10px] px-2 py-0.5 font-mono text-[10px] font-medium uppercase', RATING_TONE[rating])}>{rating}</span>
          </span>
          <span className="text-[12px] text-fg-3">{meta}</span>
        </button>
        {!open && (
          <LineChart
            className="hidden w-[200px] min-[600px]:block"
            height={36}
            min={0}
            max={100}
            series={[{ data: SAMPLE_MINUTES.map(m => levelAt(c.spec, m)), color: c.enabled ? 'var(--meter)' : 'var(--text-3)', width: 1.5 }]}
          />
        )}
        <Toggle on={c.enabled} size="md" label={`Enable ${c.name}`} disabled={locked} onChange={enabled => onSave({ ...c, enabled })} />
        <GhostIcon icon={open ? ChevronUp : ChevronDown} label={open ? `Close ${c.name}` : `Edit ${c.name}`} aria-expanded={open} className="text-fg-3" onClick={() => onOpen(!open)} />
      </div>
      {open && (
        <div className="border-t border-line px-5 py-[18px]">
          <CurveEditor schedule={c} onSave={onSave} />
        </div>
      )}
    </Card>
  )
}
