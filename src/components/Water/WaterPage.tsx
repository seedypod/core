import { withUnit } from '@/src/lib/sensorMeta'
import { toDisplay } from '@/src/lib/units'
import { CalendarClock, MoreHorizontal, Play, Plus, Square } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, GhostIcon, InlineError, Skeleton } from '@/src/components/ds/core'
import { LineChart } from '@/src/components/ds/charts'
import { DayPicker, SegmentedControl, TextField, Toggle, WeekdayDots } from '@/src/components/ds/forms'
import { Modal } from '@/src/components/ds/feedback'
import { fmtClock, fmtDate, fmtTime } from '@/src/components/charts/format'
import { bin } from '@/src/components/charts/TimeChart'
import { Chart3D, ChartNote, LoadingLine, Pending, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { tankData, type TankMarks } from '@/src/components/charts/viz3d/shape'
import { hasWebGL } from '@/src/components/Grow/TowerView'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { dayOn, daysToList, listToDays } from '@/src/lib/days'
import { pumpFault } from '@/src/lib/pumpFault'
import { localTime, systemZone } from '@/src/scheduler/time'
import { daysSinceSowing, PUMP_PRESETS, type PumpPreset } from '@/src/scheduler/pumpPlan'
import { followedPreset } from '@/src/care/follow'
import { asCurve } from '@/src/components/Light/curves'
import { trpc } from '@/src/utils/trpc'
import { asCycle, cycleWhen, fmtCountdown, fmtMinutes, fmtWhen, levelAt, nextRun, runSource, tankTrend, type PumpCycle } from './pumpCycles'
import { useNow } from '@/src/components/System/useNow'
import { useTankReserve } from './useTankReserve'
import { ProtocolLine } from './ProtocolLine'
import { DueChores } from '@/src/components/Care/ChoreItem'
import { ScheduleTimeline } from '@/src/components/charts/ScheduleTimeline'

const DURATIONS = [{ value: '60', label: '1 min' }, { value: '300', label: '5 min' }, { value: '600', label: '10 min' }, { value: '900', label: '15 min' }] as const
/** The editor's run lengths, in seconds: the presets' among them, so a 6-minute preset cycle reads as itself. */
const CYCLE_DURATIONS = [60, 180, 300, 360, 600, 900]
const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
const AXIS = 'flex justify-between font-mono text-[10px] text-fg-3'

export function WaterPage() {
  const utils = trpc.useUtils()
  const pump = trpc.pump.get.useQuery()
  const sensors = trpc.sensors.latest.useQuery()
  const system = trpc.system.info.useQuery()
  const settings = trpc.settings.get.useQuery()
  const schedules = trpc.schedules.list.useQuery()
  const runs = trpc.schedules.recentRuns.useQuery()
  // When Run was pressed, until the pump answers by coming on.
  const [asked, setAsked] = useState<number | null>(null)
  const runOnce = trpc.pump.runOnce.useMutation({ onSuccess: () => utils.pump.invalidate(), onError: () => setAsked(null) })
  const stop = trpc.pump.stop.useMutation({ onSuccess: () => utils.pump.invalidate() })
  // The grow protocol reads the pump cycles (whose watering it is), so its line here is read again with them.
  const cyclesChanged = () => {
    void utils.schedules.invalidate()
    void utils.protocol.invalidate()
  }
  const upsert = trpc.schedules.upsert.useMutation({ onSuccess: cyclesChanged })
  const remove = trpc.schedules.remove.useMutation({ onSuccess: cyclesChanged })
  const [dur, setDur] = useState<typeof DURATIONS[number]['value']>('300')
  const [editing, setEditing] = useState<PumpCycle | null>(null)
  const [hours, setHours] = useState<Hours>('168')
  const grow = trpc.grow.current.useQuery()
  const pods = trpc.grow.pods.useQuery()
  // The tank in 3D heads the page; without WebGL the flat meter and the history chart below stand in.
  const [flat, setFlat] = useState(() => !hasWebGL())
  const p = pump.data
  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const limits = system.data?.system?.limits
  const cfg = settings.data
  const tank = s.water_level_pct && Math.round(s.water_level_pct.value)
  // The one place "in the reserve" is decided, for the readout, the meter and the scene alike.
  const { cutoff, low } = useTankReserve(s)
  const cycles = useMemo(() => (schedules.data ?? []).flatMap(x => asCycle(x) ?? []).sort((a, b) => a.spec.minute - b.spec.minute), [schedules.data])
  const curves = useMemo(() => (schedules.data ?? []).flatMap(x => asCurve(x) ?? []), [schedules.data])
  const now = new Date()
  // The cycles run on the unit's clock, so today and now are its, not this browser's.
  const zone = cfg?.timezone ?? systemZone()
  const { minute: nowMin, weekday } = localTime(now, zone)
  const next = nextRun(cycles, now, zone)
  const planted = (pods.data ?? []).filter(x => x.status !== 'empty')
  const sown = daysSinceSowing(grow.data?.cycle?.startedAt, planted.map(x => x.plantedAt), now, zone)
  // Sown today and germination's run time has gone by with no run yet: the first watering is still owed.
  const germination = PUMP_PRESETS.find(x => x.weekly) ?? null
  const today = localTime(now, zone).date
  // A run before the open cycle began was for the last sowing, not this one.
  const cycleStart = grow.data?.cycle ? Date.parse(grow.data.cycle.startedAt) : null
  const ranToday = (runs.data ?? []).some(r => germination && r.scheduleId.startsWith(`water-${germination.slug}-`) && localTime(new Date(r.firedAt), zone).date === today && (cycleStart === null || Date.parse(r.firedAt) >= cycleStart))
  const missed = germination && sown === 0 && nowMin >= (germination.minutes[0] ?? 0) && !ranToday ? germination : null
  // Running by the same rule Follow goes by: every cycle the preset's, on, on its days, its length. Paused or trimmed, they're your own.
  const running = followedPreset(cycles)
  const runNow = (durationS: number) => {
    setAsked(Date.now())
    runOnce.mutate({ durationS })
  }
  const lastRun = (id: string) => {
    const r = (runs.data ?? []).find(r => r.scheduleId === id)
    return r ? new Date(r.firedAt) : null
  }
  const isNew = !!editing && !cycles.some(c => c.id === editing.id)

  // The strip below says what the current guard measured; up here, which fault it is.
  const pumpLine = p ? (p.on ? `watering at ${p.level}%` : p.fault ? `pump fault: ${pumpFault(p.fault).reason}` : 'pump idle') : '…'
  const subtitle = [pumpLine, next ? `next run ${fmtClock(next.cycle.spec.minute)}` : null].filter(Boolean).join(' · ')
  const limitsLine = limits ? `Up to ${fmtMinutes(limits.pumpMaxRunS)} per run at ${limits.pumpMaxDuty}% duty. Won't start below ${limits.waterLowCm == null ? '— cm' : withUnit(limits.waterLowCm, 'cm')} of water.` : undefined

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Water</h1>
        <div className="flex flex-wrap items-center gap-3">
          <p className={cn('text-[13px]', p?.fault ? 'text-danger' : 'text-fg-2')}>{subtitle}</p>
          {p?.fault && <ClearFault />}
        </div>
      </div>

      <Card tone={p?.fault ? 'danger' : undefined} className="@container gap-0 overflow-hidden p-0">
        <PumpStrip
          pump={p ?? undefined}
          at={pump.dataUpdatedAt}
          readings={s}
          // A preset's cycle is named for its time already ("… (08:00)"); the strip says the time once.
          next={next ? `Next run ${fmtClock(next.cycle.spec.minute)} (${next.cycle.name.replace(/\s*\(\d\d:\d\d\)$/, '')})` : null}
          unscheduled={schedules.data !== undefined && !next}
          onSchedule={() => document.getElementById('pump-cycles')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
          source={p?.on ? runSource(runs.data ?? [], cycles, p.since) : null}
          limits={limitsLine}
          dur={dur}
          onDur={setDur}
          starting={asked !== null}
          runError={runOnce.error?.message ?? null}
          asked={p?.on ? null : asked}
          onGiveUp={() => setAsked(null)}
          stopping={stop.isPending}
          onRun={() => runNow(Number(dur))}
          onStop={() => stop.mutate()}
        />
        {asked !== null && p?.on && <Started onSeen={() => setAsked(null)} />}
        <div className="flex flex-col gap-3.5 px-[22px] pb-5 pt-4">
          {flat
            ? (
                <>
                  <TankReadout tank={tank} capacityL={cfg?.tankCapacityL} reserve={low} />
                  <div className="relative h-2.5 rounded-full bg-line" role="meter" aria-label="Tank level" aria-valuenow={tank ?? 0} aria-valuemin={0} aria-valuemax={100} aria-description={reserveWords(cutoff)}>
                    <div className={cn('h-full rounded-full bg-tank transition-[width] duration-700', low && 'opacity-60')} style={{ width: `${tank ?? 0}%` }} />
                    {cutoff !== null && <div aria-hidden data-testid="tank-reserve" className={cn('tank-reserve absolute inset-y-0 left-0', cutoff >= 100 ? 'rounded-full' : 'rounded-l-full')} style={{ width: `${cutoff}%` }} />}
                    {cutoff !== null && <div className="absolute -top-1 h-[18px] w-px bg-pod-ready" style={{ left: `${cutoff}%` }} />}
                  </div>
                  <TankScale cutoff={cutoff} emptyCm={cfg?.waterEmptyCm} fullCm={cfg?.waterFullCm} />
                  <TankStats readings={s} />
                </>
              )
            : (
                <TankBody
                  hours={hours}
                  onHours={setHours}
                  tank={tank}
                  capacityL={cfg?.tankCapacityL}
                  cutoff={cutoff}
                  low={low}
                  current={s.water_level_pct?.value ?? null}
                  run={p?.on ? { since: p.since } : null}
                  ran={(runs.data ?? []).filter(r => cycles.some(c => c.id === r.scheduleId)).map(r => r.firedAt)}
                  nowMin={nowMin}
                  later={cycles.filter(c => c.enabled && dayOn(c.days, weekday) && c.spec.minute > nowMin).map(c => c.spec.minute)}
                  marks={{
                    full: `full · ${cfg ? withUnit(cfg.waterFullCm, 'cm') : '—'}`,
                    now: `now · ${fmt(s.water_distance)}`,
                    cutoff: cutoff !== null && limits?.waterLowCm != null ? `cutoff ${cutoff}% · ${withUnit(limits.waterLowCm, 'cm')}` : null,
                    empty: `empty · ${cfg ? withUnit(cfg.waterEmptyCm, 'cm') : '—'}`,
                    short: { full: 'full', now: `now ${fmt(s.water_distance)}`, cutoff: cutoff !== null ? `cutoff ${cutoff}%` : null, empty: 'empty' },
                  }}
                  onUnavailable={() => setFlat(true)}
                />
              )}
        </div>
      </Card>

      <div id="pump-cycles" className="flex scroll-mt-6 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[12rem] flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className={EYEBROW}>Pump cycles</h2>
          {/* What runs now: a preset by name, or cycles of your own; nothing with none. */}
          {cycles.length > 0 && (
            <span className="flex items-center gap-1.5 text-[12px] text-fg-2" data-testid="pump-running">
              <span className="text-fg-3">·</span>
              {running && <span className="size-2 shrink-0 rounded-full bg-tank" />}
              {running ? `${running.name} running` : 'custom cycles'}
            </span>
          )}
        </div>
        <FollowToggle />
        <Button icon={Plus} onClick={() => setEditing({ id: `pump-${Date.now().toString(36)}`, kind: 'pump', name: 'Watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })}>Add custom cycle</Button>
      </div>
      <ScheduleTimeline
        lead="water"
        curves={curves}
        cycles={cycles}
        timezone={cfg?.timezone}
        pumpRun={p?.on ? { since: p.since, remainingS: p.remainingS } : null}
      />
      {/* Which stage of the grow protocol the cycles are on, and when they next change: set on Grow. */}
      <ProtocolLine />
      {missed && <MissedRun preset={missed} busy={!!p?.on || asked !== null} onRun={() => runNow(missed.durationS)} />}
      {cycles.length > 0 && (
        <Card className="gap-0 p-0" data-testid="pump-cycle-list">
          {cycles.map(c => (
            <div key={c.id} className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-4 last:border-0">
              <span className={cn('w-[76px] font-mono text-xl font-medium', !c.enabled && 'text-fg-3')}>{fmtClock(c.spec.minute)}</span>
              <button type="button" className="flex min-w-[160px] flex-1 cursor-pointer flex-col gap-[3px] text-left" onClick={() => setEditing(c)}>
                <span className={cn('text-sm font-medium', !c.enabled && 'text-fg-2')}>{c.name}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-3">
                  {fmtMinutes(c.spec.durationS) + (c.spec.level ? ` at ${c.spec.level}%` : '')}
                  <WeekdayDots days={c.days} />
                </span>
              </button>
              <span className="font-mono text-[11px] text-fg-3">{cycleWhen(c, lastRun(c.id), now, zone)}</span>
              <Toggle on={c.enabled} size="md" label={`Enable ${c.name}`} onChange={enabled => upsert.mutate({ ...c, enabled })} />
              <GhostIcon icon={MoreHorizontal} label={`Edit ${c.name}`} className="text-fg-3" onClick={() => setEditing(c)} />
            </div>
          ))}
        </Card>
      )}

      <DueChores />

      {flat && <TankHistory cutoff={cutoff} />}

      <div className="flex flex-col gap-2.5">
        <h2 className={EYEBROW}>Recent runs</h2>
        <Card className="gap-0 p-0">
          {(runs.data ?? []).length === 0 && <p className="px-5 py-3 text-[13px] text-fg-3">No scheduled runs yet.</p>}
          {(runs.data ?? []).slice(0, 10).map((r) => {
            const c = cycles.find(c => c.id === r.scheduleId)
            return (
              <div key={r.key} className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-3 text-[13px] last:border-0">
                <span className="size-[7px] rounded-full bg-pod-ok" />
                <span className="min-w-[140px] flex-1">{c?.name ?? r.scheduleId}</span>
                {c && <span className="font-mono text-[12px] text-fg-2">{fmtMinutes(c.spec.durationS)}</span>}
                <span className="min-w-[120px] text-right font-mono text-[12px] text-fg-3">{fmtWhen(new Date(r.firedAt), now)}</span>
              </div>
            )
          })}
        </Card>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.name ?? ''}
        icon={CalendarClock}
        footer={editing && (
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                upsert.mutate(editing)
                setEditing(null)
              }}
            >
              Save
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            {!isNew && (
              <Button
                variant="danger"
                className="ml-auto"
                onClick={() => {
                  remove.mutate({ id: editing.id })
                  setEditing(null)
                }}
              >
                Delete
              </Button>
            )}
          </div>
        )}
      >
        {editing && (
          <div className="flex flex-col gap-4">
            <TextField label="Name" mono={false} value={editing.name} onChange={v => setEditing({ ...editing, name: v })} />
            <label className="flex flex-col gap-1.5 text-xs text-fg-2">
              Time
              <input
                type="time"
                className="lp-btn font-mono"
                value={fmtClock(editing.spec.minute)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number)
                  setEditing({ ...editing, spec: { ...editing.spec, minute: (h ?? 0) * 60 + (m ?? 0) } })
                }}
              />
            </label>
            <div className="flex flex-col gap-1.5 text-xs text-fg-2">
              Duration
              <SegmentedControl value={String(editing.spec.durationS)} options={editorLengths(editing.spec.durationS).map(d => ({ value: String(d), label: fmtMinutes(d) }))} onChange={v => setEditing({ ...editing, spec: { ...editing.spec, durationS: Number(v) } })} />
            </div>
            <div className="flex flex-col gap-1.5 text-xs text-fg-2">
              Days
              <DayPicker value={daysToList(editing.days)} onChange={v => setEditing({ ...editing, days: listToDays(v) })} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

/** The editor's lengths, with a cycle's own if it's none of them, so editing never changes it unasked. */
export function editorLengths(current: number): number[] {
  return CYCLE_DURATIONS.includes(current) ? CYCLE_DURATIONS : [...CYCLE_DURATIONS, current].sort((a, b) => a - b)
}

const RANGES = [{ value: '24', label: '24h' }, { value: '168', label: '7d' }, { value: '720', label: '30d' }] as const
type Hours = typeof RANGES[number]['value']

/** The tank's history over a range: levels binned onto an even grid, its top-ups and drain rate, min / avg / max, and the words for them. */
function useTankHistory(hours: Hours) {
  const h = Number(hours)
  const q = trpc.telemetry.history.useQuery({ sensor: 'water_level_pct', hours: h, maxPoints: 300 }, { refetchInterval: 60_000 })
  const raw = (q.data ?? []).map(p => p.value)
  // Samples come at uneven times; bin them onto an even grid so the x axis reads as time.
  const { xs, data } = bin([{ name: 'Tank', points: (q.data ?? []).map(p => ({ x: Date.parse(p.ts), y: p.value })) }], 150)
  const values = data[0] ?? []
  const { topUps, dropPerDay } = tankTrend(xs, values)
  const stats = raw.length ? { min: Math.min(...raw), avg: raw.reduce((a, b) => a + b, 0) / raw.length, max: Math.max(...raw) } : null
  const label = (i: number) => {
    const ts = xs[i] ?? 0
    return h <= 24 ? fmtTime(ts) : h <= 168 ? new Date(ts).toLocaleDateString([], { weekday: 'short' }) : fmtDate(ts)
  }
  const ticks = values.length > 1 ? [0, 1, 2, 3, 4].map(k => Math.round((k / 4) * (values.length - 1))) : []
  const summary = [
    topUps.length === 0 ? 'No top-ups' : topUps.length === 1 ? 'One top-up' : `${topUps.length} top-ups`,
    h <= 24 ? ' today.' : h <= 168 ? ' this week.' : ' this month.',
    dropPerDay ? ` Drops about ${dropPerDay}% a day.` : '',
  ].join('')
  const heroSummary = [
    `${topUps.length === 0 ? 'No top-ups' : topUps.length === 1 ? 'One top-up' : `${topUps.length} top-ups`} ${h <= 24 ? 'today' : h <= 168 ? 'this week' : 'this month'}`,
    dropPerDay ? `drops about ${dropPerDay}% a day` : null,
  ].filter(Boolean).join(' · ')
  return { q, h, xs, values, topUps, stats, label, ticks, summary, heroSummary }
}

/** The level now in big type, and about how much water that is. */
/** The hatching in words, for the meter and the charts. */
function reserveWords(cutoff: number | null): string | undefined {
  return cutoff === null ? undefined : `The bottom ${cutoff}%, below the pump cutoff, is hatched: the pump won't draw it.`
}

function TankReadout({ tank, capacityL, reserve = false }: { tank: number | undefined, capacityL: number | undefined, reserve?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <span className="font-mono text-[44px] font-medium leading-none"><Pending loading={tank === undefined} sample="100%">{`${tank}%`}</Pending></span>
      {tank !== undefined && capacityL !== undefined && <span className="text-[13px] text-fg-2">{`≈ ${toDisplay(Math.round(capacityL * tank / 10) / 10, 'L').value} of ${withUnit(capacityL, 'L')}`}</span>}
      {reserve && <span className="text-[13px] font-medium text-pod-ready" data-testid="tank-in-reserve">{'Below the pump cutoff · the pump won\'t start'}</span>}
    </div>
  )
}

/** The key to the hatching: the water under the pump cutoff, which the pump won't draw. */
function ReserveLegend({ cutoff }: { cutoff: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-pod-ready">
      <span aria-hidden className="tank-reserve h-2.5 w-3.5 rounded-[2px]" />
      {`unusable · below pump cutoff ${cutoff}%`}
    </span>
  )
}

/** Empty, the pump cutoff and full, under the meter or the scene. */
function TankScale({ cutoff, emptyCm, fullCm }: { cutoff: number | null, emptyCm: number | undefined, fullCm: number | undefined }) {
  return (
    <div className={cn(AXIS, 'items-center')}>
      <span>{emptyCm !== undefined ? `empty · ${withUnit(emptyCm, 'cm')}` : 'empty'}</span>
      {cutoff !== null && <ReserveLegend cutoff={cutoff} />}
      <span>{fullCm !== undefined ? `full · ${withUnit(fullCm, 'cm')}` : 'full'}</span>
    </div>
  )
}

/** The sensor's distance to the water, and the pump's power, current and supply. */
function TankStats({ readings: s }: { readings: Partial<Record<SensorId, Reading>> }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-2.5 font-mono text-[12px] text-fg-3">
      <span>
        {'distance '}
        <span className="text-fg">{fmt(s.water_distance)}</span>
      </span>
      <span>
        {'pump '}
        <span className="text-fg">{`${fmt(s.pump_w)} · ${fmt(s.pump_a)}`}</span>
      </span>
      <span>
        {'supply '}
        <span className="text-fg">{fmt(s.pump_v)}</span>
      </span>
    </div>
  )
}

/** The range picker over the hero's chart: plain words, the chosen one underlined, so they don't read as the run-length chips. */
function RangeTabs({ value, onChange }: { value: Hours, onChange: (v: Hours) => void }) {
  return (
    <div role="tablist" aria-label="Tank level range" className="flex gap-3.5 font-mono text-[12px]">
      {RANGES.map(r => (
        <button
          key={r.value}
          type="button"
          role="tab"
          aria-selected={value === r.value}
          onClick={() => onChange(r.value)}
          className={cn('cursor-pointer border-0 border-b bg-transparent px-0 pb-0.5', value === r.value ? 'border-fg text-fg' : 'border-transparent text-fg-3 hover:text-fg-2')}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The hero's body with WebGL: the level now in big type and one line under
 * it (the week's top-ups and drain, or how far this run has drawn it down),
 * then the history and the glass on one scale. Without WebGL it calls
 * `onUnavailable`, and the page goes flat.
 */
function TankBody({ hours, onHours, tank, capacityL, cutoff, low, current, run, ran, nowMin, later, marks, onUnavailable }: {
  hours: Hours
  onHours: (h: Hours) => void
  /** A preset's run times (minutes of the day) shown before it's applied. */
  tank: number | undefined
  capacityL: number | undefined
  cutoff: number | null
  /** The water is down in the reserve under the cutoff, so the pump won't start. */
  low: boolean
  current: number | null
  run: { since: string } | null
  /** When scheduled runs fired. */
  ran: string[]
  /** Minutes of today now, and that the enabled cycles still run at. */
  nowMin: number
  later: number[]
  marks: TankMarks
  onUnavailable: () => void
}) {
  const t = useTankHistory(hours)
  const status = vizStatus([t.q], t.values.length === 0)
  const x0 = t.xs[0] ?? 0
  const x1 = t.xs.at(-1) ?? 0
  const runFrom = run && x1 > x0 ? (Date.parse(run.since) - x0) / (x1 - x0) : null
  const ticks = t.values.length > 1 ? [0, 1, 2, 3, 4].map(k => ({ at: k / 5, label: t.label(Math.round((k / 5) * (t.values.length - 1))) })).concat({ at: 1, label: 'now' }) : []
  // A run fired since the last sample still sits at the end of the line.
  const along = (iso: string) => (x1 > x0 ? Math.min(1, (Date.parse(iso) - x0) / (x1 - x0)) : -1)
  const scene = status === 'ready'
    ? tankData({
        levels: t.values,
        topUps: t.topUps,
        cutoffPct: cutoff,
        low,
        currentPct: current,
        ticks,
        marks,
        pumping: !!run,
        runFrom,
        runs: ran.map(along),
        // Today's runs still to come only fit the day's own range.
        upcoming: t.h <= 24 ? later.map(m => (m - nowMin) / (1440 - nowMin)) : [],
      })
    : null
  const before = run ? levelAt(t.q.data ?? [], run.since) : null
  const line = run
    ? (before !== null && current !== null ? `Down ${Math.max(0, Math.round(before - current))}% so far this run` : 'Watering now')
    : t.heroSummary
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <TankReadout tank={tank} capacityL={capacityL} reserve={low} />
          <span className={cn('min-h-[18px] text-[12px]', run ? 'text-tank' : 'text-fg-3')} data-testid="tank-summary">
            {status === 'loading' && !run ? <LoadingLine /> : t.values.length > 1 || run ? line : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <ChartNote status={status} stale={staleSince([t.q])} onRetry={() => void t.q.refetch()} />
          <RangeTabs value={hours} onChange={onHours} />
        </div>
      </div>
      <Chart3D
        kind="tank"
        data={scene}
        status={status}
        label={[`Tank at ${tank ?? '—'}%, and its level over the last ${t.h <= 24 ? 'day' : t.h <= 168 ? 'week' : 'month'}${run ? ', with the pump running' : ''}.`, status === 'ready' ? reserveWords(cutoff) : undefined].filter(Boolean).join(' ')}
        message={status === 'error' ? `Couldn't load the tank history: ${t.q.error?.message ?? ''}` : 'No tank level recorded in this window.'}
        fallback={null}
        onUnavailable={onUnavailable}
      />
      {cutoff !== null && status === 'ready' && <div className="flex justify-end"><ReserveLegend cutoff={cutoff} /></div>}
    </>
  )
}

/** Germination's run for today has gone by: say so, and offer the run by hand. Nothing runs by itself. */
function MissedRun({ preset, busy, onRun }: { preset: PumpPreset, busy: boolean, onRun: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] leading-snug text-pod-ready" data-testid="pump-missed">
      <span>{`Today’s ${fmtClock(preset.minutes[0] ?? 0)} run has passed: water the pods now?`}</span>
      <Button size="sm" icon={Play} disabled={busy} onClick={onRun}>{`Run ${fmtMinutes(preset.durationS)} now`}</Button>
    </div>
  )
}

const CHIP = 'grid size-8 cursor-pointer place-items-center rounded-[7px] border font-mono text-[12px]'

/**
 * The top band of the Water card: what the pump is doing and the one control
 * for it. Idle, it says so with the next run and the supply, and offers the
 * run lengths and Run; running, it tints blue with the run's source, duty and
 * power, a countdown and Stop, and a progress line along its foot. Both states
 * are the same height, so the body below never moves.
 */
function PumpStrip({ pump: p, at, readings: s, next, unscheduled, onSchedule, runError, asked, onGiveUp, source, limits, dur, onDur, starting, stopping, onRun, onStop }: {
  pump: { on: boolean, level: number, since: string, fault: string | null, remainingS: number | null } | undefined
  at: number
  readings: Partial<Record<SensorId, Reading>>
  next: string | null
  /** No cycle will run: the subtitle says so and leads to the pump cycles. */
  unscheduled: boolean
  onSchedule: () => void
  /** A preset on show before it's applied. */
  /** Why the last Run was refused. */
  runError: string | null
  /** When Run was pressed, while the pump hasn't come on. */
  asked: number | null
  onGiveUp: () => void
  source: string | null
  limits: string | undefined
  dur: typeof DURATIONS[number]['value']
  onDur: (v: typeof DURATIONS[number]['value']) => void
  starting: boolean
  stopping: boolean
  onRun: () => void
  onStop: () => void
}) {
  const running = !!p?.on
  const usual = (
    <span className="truncate">
      {unscheduled && <button type="button" onClick={onSchedule} className="cursor-pointer border-0 bg-transparent p-0 text-fg-2 underline underline-offset-2 hover:text-fg">No watering schedule</button>}
      {[unscheduled ? null : next, s.pump_v ? `supply ${fmt(s.pump_v)}` : null].filter(Boolean).map((t, i) => (unscheduled || i > 0 ? ` · ${t}` : t)).join('')}
    </span>
  )
  // What the idle strip says under its title, first match wins: why the last Run was refused, a fault, a Run
  // that hasn't started (the usual line until it has something to say), else the next run and the supply.
  const subtitle = (): ReactNode => {
    if (runError) return <span className="truncate text-danger" title={runError}>{runError}</span>
    if (p?.fault) {
      const why = pumpFault(p.fault).detail ?? p.fault
      return <span className="truncate" title={why}>{why}</span>
    }
    if (asked !== null) return <NotStarted asked={asked} onGiveUp={onGiveUp}>{usual}</NotStarted>
    return usual
  }
  const status = (dot: string, title: string, sub: ReactNode) => (
    <div className="flex h-11 min-w-0 items-center gap-3">
      <span className={cn('size-2.5 shrink-0 rounded-full', dot)} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-medium leading-tight">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3">{sub}</span>
      </div>
    </div>
  )
  return (
    <div
      data-testid="pump-strip"
      data-state={running ? 'running' : 'idle'}
      className={cn('relative flex flex-col gap-3 border-b border-line px-[22px] py-3.5 @min-[620px]:flex-row @min-[620px]:items-center @min-[620px]:justify-between', running ? 'bg-tank/15' : 'bg-active/40')}
    >
      {running && p
        ? (
            <PumpRunning pump={p} at={at} readings={s} source={source} stopping={stopping} onStop={onStop} status={status} />
          )
        : (
            <>
              {status(
                p?.fault ? 'bg-danger' : 'bg-fg-3',
                p ? (p.fault ? 'Pump fault' : 'Pump idle') : 'Pump',
                subtitle(),
              )}
              <div className="flex h-10 items-center gap-2">
                <span className="text-[12px] text-fg-3">Run for</span>
                <div role="radiogroup" aria-label="Run length" className="flex gap-1">
                  {DURATIONS.map(d => (
                    <button
                      key={d.value}
                      type="button"
                      role="radio"
                      aria-checked={dur === d.value}
                      aria-label={d.label}
                      onClick={() => onDur(d.value)}
                      className={cn(CHIP, dur === d.value ? 'border-fg-2 bg-active text-fg' : 'border-line-2 bg-transparent text-fg-2 hover:text-fg')}
                    >
                      {Number(d.value) / 60}
                    </button>
                  ))}
                </div>
                <span className="text-[12px] text-fg-3">min</span>
                <Button variant="primary" icon={Play} className="ml-1.5 px-3.5" title={limits} disabled={!!p?.fault || starting} onClick={onRun}>
                  {starting ? 'Starting…' : 'Run'}
                </Button>
              </div>
            </>
          )}
    </div>
  )
}

/** The strip while the pump runs; its own component for the countdown's clock. */
function PumpRunning({ pump: p, at, readings: s, source, stopping, onStop, status }: {
  pump: { level: number, since: string, remainingS: number | null }
  at: number
  readings: Partial<Record<SensorId, Reading>>
  source: string | null
  stopping: boolean
  onStop: () => void
  status: (dot: string, title: string, sub: ReactNode) => ReactNode
}) {
  const run = useRun(p.since, p.remainingS, at)
  const sub = [source ?? 'Manual', `${p.level}% duty`, fmt(s.pump_w), fmt(s.pump_a), fmt(s.pump_v)].join(' · ')
  return (
    <>
      {status('animate-pulse bg-tank motion-reduce:animate-none', 'Watering', <span className="truncate">{sub}</span>)}
      <div className="flex h-10 items-center gap-3">
        {run
          ? (
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-[26px] font-medium leading-none" data-testid="run-left">{fmtCountdown(run.left)}</span>
                <span className="text-[12px] text-fg-3">{`of ${run.total >= 60 ? `${Math.round(run.total / 60)} min` : fmtMinutes(run.total)}`}</span>
              </span>
            )
          : <span className="text-[12px] text-fg-3">until stopped</span>}
        <Button icon={Square} className="px-3.5" disabled={stopping} onClick={onStop} data-testid="stop-pump">Stop</Button>
      </div>
      {run && (
        <div className="absolute inset-x-0 bottom-0 h-0.5" role="progressbar" aria-label="Watering" aria-valuenow={Math.round(run.done)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-tank transition-[width] duration-1000 ease-linear" style={{ width: `${run.done}%` }} />
        </div>
      )}
    </>
  )
}

/** Without WebGL: the tank's level over a range as a flat chart, with each top-up marked and the drain rate between them. */
function TankHistory({ cutoff }: { cutoff: number | null }) {
  const [hours, setHours] = useState<Hours>('168')
  const { q, h, xs, values, topUps, stats, label, ticks, summary } = useTankHistory(hours)
  return (
    <Card className="gap-3.5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-1 flex-col gap-[3px]">
          <span className="text-[15px] font-medium">Tank level</span>
          {values.length > 1 && <span className="text-[12px] text-fg-3" data-testid="tank-summary">{summary}</span>}
        </div>
        <SegmentedControl size="sm" ariaLabel="Tank level range" value={hours} options={RANGES} onChange={setHours} className="font-mono" />
      </div>
      {q.isLoading && <Skeleton className="h-[160px] w-full" />}
      {q.error && <InlineError>{`Couldn't load the tank history: ${q.error.message}`}</InlineError>}
      {!q.isLoading && !q.error && (values.length === 0
        ? <p className="flex h-[160px] items-center justify-center text-[12px] text-fg-3">No tank level recorded in this window.</p>
        : (
            <>
              <LineChart
                height={160}
                min={0}
                max={100}
                guides={cutoff !== null ? [{ value: cutoff, below: 'tank-reserve' }] : []}
                series={[
                  { data: values, color: 'var(--meter)', fill: true, width: 1.5 },
                  { data: values.map((v, i) => (topUps.includes(i) ? v : Number.NaN)), color: 'var(--pod-ok)', dots: true, width: 4 },
                ]}
                xLabel={i => (h <= 24 ? fmtTime(xs[i] ?? 0) : new Date(xs[i] ?? 0).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}
                format={(v, s) => (s === 0 ? `${Math.round(v)}%` : 'topped up')}
              />
              <div className={AXIS} aria-hidden>
                {ticks.map((i, k) => <span key={k}>{label(i)}</span>)}
              </div>
              {cutoff !== null && <div className="flex justify-end" aria-description={reserveWords(cutoff)}><ReserveLegend cutoff={cutoff} /></div>}
            </>
          ))}
      {stats && (
        <div className="flex flex-wrap gap-6 border-t border-line pt-2.5 font-mono text-[12px] text-fg-3" data-testid="tank-stats">
          {(['min', 'avg', 'max'] as const).map(k => (
            <span key={k}>
              {`${k} `}
              <span className="text-fg">{`${Math.round(stats[k])}%`}</span>
            </span>
          ))}
        </div>
      )}
    </Card>
  )
}

function fmt(r: { value: number, unit: string } | undefined): string {
  return r ? withUnit(r.value, r.unit) : '—'
}

/** Clears the pump's latched fault from here, as Alerts does, once the cause is fixed. A dry-run clears by itself after a minute of good water. */
function ClearFault() {
  const utils = trpc.useUtils()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const ack = trpc.alerts.acknowledge.useMutation({
    onSuccess: () => {
      void utils.alerts.invalidate()
      void utils.pump.invalidate()
    },
  })
  const fault = (alerts.data ?? []).find(a => a.kind === 'pump_fault')
  if (!fault) return null
  return (
    <>
      <Button className="px-3 py-[5px] text-[13px]" disabled={ack.isPending} onClick={() => ack.mutate({ id: fault.id })}>Clear fault</Button>
      {ack.error && <InlineError>{ack.error.message}</InlineError>}
    </>
  )
}

/** The seconds a run has left, its whole length and how far through it is, counted down here between the pump's updates. */
function useRun(since: string, remainingS: number | null, at: number) {
  const now = useNow(1000)
  if (remainingS === null) return null
  const end = (at || now) + remainingS * 1000
  const total = Math.max(1, (end - Date.parse(since)) / 1000)
  const left = Math.max(0, (end - now) / 1000)
  return { left, total, done: Math.min(100, Math.max(0, (1 - left / total) * 100)) }
}

/** Once the pump comes on after Run, let go of the request. */
function Started({ onSeen }: { onSeen: () => void }) {
  useEffect(onSeen, [onSeen])
  return null
}

/** How long the pump gets to come on after Run before the page says it didn't, and why if an alert says. */
export const START_WAIT_MS = 6000

function NotStarted({ asked, onGiveUp, children }: { asked: number, onGiveUp: () => void, children: ReactNode }) {
  const now = useNow(1000)
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  if (now - asked < START_WAIT_MS) return <>{children}</>
  const open = alerts.data ?? []
  const low = open.find(a => a.kind === 'water_low')
  const fault = open.find(a => a.kind === 'pump_fault')
  const why = low ? `the tank reads low (${low.detail})` : fault ? `the pump has a fault (${fault.detail})` : 'the hardware refused it; see Alerts'
  // One line in the strip's subtitle: the reason truncates, Try again stays.
  return (
    <>
      <span className="truncate text-danger" title={`Didn't start: ${why}.`}>{`Didn't start: ${why}.`}</span>
      <button type="button" className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-danger underline" onClick={onGiveUp}>Try again</button>
    </>
  )
}

/** Whether the unit moves its pump cycles to each growth stage's preset by itself (src/care/follow.ts). */
function FollowToggle() {
  const utils = trpc.useUtils()
  const settings = trpc.settings.get.useQuery()
  const update = trpc.settings.update.useMutation({ onSuccess: () => {
    void utils.settings.invalidate()
    void utils.protocol.invalidate()
  } })
  const on = settings.data?.followGrowCycle ?? false
  return (
    <span className="flex items-center gap-2 text-[13px] text-fg-2" title="As the plants age, move the cycles on to the next stage's preset, never back. Cycles you set by hand are left alone. While on, germination's weekly run keeps to the sowing weekday.">
      Follow the grow cycle
      <Toggle on={on} size="md" label="Follow the grow cycle" disabled={!settings.data || update.isPending} onChange={followGrowCycle => update.mutate({ followGrowCycle })} />
    </span>
  )
}
