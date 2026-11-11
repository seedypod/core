import { withUnit } from '@/src/lib/sensorMeta'
import { toDisplay } from '@/src/lib/units'
import { CalendarClock, MoreHorizontal, Play, Plus, Square } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, GhostIcon, InlineError, Skeleton } from '@/src/components/ds/core'
import { LineChart } from '@/src/components/ds/charts'
import { DayPicker, SegmentedControl, TextField, Toggle } from '@/src/components/ds/forms'
import { Modal } from '@/src/components/ds/feedback'
import { fmtClock, fmtDate, fmtTime } from '@/src/components/charts/format'
import { bin } from '@/src/components/charts/TimeChart'
import { Chart3D, ChartNote, LoadingLine, Pending, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { tankData, type TankMarks } from '@/src/components/charts/viz3d/shape'
import { hasWebGL } from '@/src/components/Grow/TowerView'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { dayOn, daysLabel, daysToList, listToDays, weekdayOf } from '@/src/lib/days'
import { dailyMinutes, daysSinceSowing, GARDYN_WATERING_GUIDE, lightWindow, presetRuns, presetSchedules, PUMP_PRESETS, recommendPreset, TIPS_CITATION, WATERING_TIPS, type PumpPresetId } from '@/src/scheduler/pumpPlan'
import { asCurve, runningToday } from '@/src/components/Light/curves'
import { trpc } from '@/src/utils/trpc'
import { asCycle, cutoffPct, cycleWhen, fmtCountdown, fmtMinutes, fmtWhen, levelAt, nextRun, runSource, tankTrend, type PumpCycle } from './pumpCycles'
import { useNow } from '@/src/components/System/useNow'
import { CareSummary } from '@/src/components/Care/CareSummary'

const DURATIONS = [{ value: '60', label: '1 min' }, { value: '300', label: '5 min' }, { value: '600', label: '10 min' }, { value: '900', label: '15 min' }] as const
const CYCLE_DURATIONS = ['60', '180', '300', '600', '900'] as const
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
  const upsert = trpc.schedules.upsert.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const remove = trpc.schedules.remove.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const [dur, setDur] = useState<typeof DURATIONS[number]['value']>('300')
  const [editing, setEditing] = useState<PumpCycle | null>(null)
  // A preset shown on the chart and the strip before it's applied, and the confirmation before it replaces the cycles.
  const [preview, setPreview] = useState<PumpPresetId | null>(null)
  const [confirming, setConfirming] = useState(false)
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
  const cutoff = cutoffPct(limits?.waterLowCm, cfg?.waterFullCm, cfg?.waterEmptyCm)
  const cycles = (schedules.data ?? []).flatMap(x => asCycle(x) ?? []).sort((a, b) => a.spec.minute - b.spec.minute)
  const now = new Date()
  const next = nextRun(cycles, now)
  const light = lightWindow(runningToday((schedules.data ?? []).flatMap(x => asCurve(x) ?? []), weekdayOf(now)).map(c => c.spec))
  const planted = (pods.data ?? []).filter(x => x.status !== 'empty')
  const sown = daysSinceSowing(grow.data?.cycle?.startedAt, planted.map(x => x.plantedAt), now)
  const recommended = recommendPreset(sown, planted.map(x => x.plant))
  const previewing = PUMP_PRESETS.find(x => x.id === preview) ?? null
  const previewRuns = previewing ? presetRuns(previewing, light) : null
  const apply = () => {
    if (!previewing) return
    const fresh = presetSchedules(previewing, { enabled: true, light })
    // Applying replaces the cycles; one with a new schedule's id is replaced by the upsert itself.
    for (const c of cycles) if (!fresh.some(f => f.id === c.id)) remove.mutate({ id: c.id })
    for (const sch of fresh) upsert.mutate(sch)
    setPreview(null)
    setConfirming(false)
  }
  const lastRun = (id: string) => {
    const r = (runs.data ?? []).find(r => r.scheduleId === id)
    return r ? new Date(r.firedAt) : null
  }
  const isNew = !!editing && !cycles.some(c => c.id === editing.id)

  const pumpLine = p ? (p.on ? `watering at ${p.level}%` : p.fault ? `pump fault: ${p.fault}` : 'pump idle') : '…'
  const subtitle = [pumpLine, next ? `next run ${fmtClock(next.cycle.spec.minute)}` : null].filter(Boolean).join(' · ')
  const limitsLine = limits ? `Up to ${fmtMinutes(limits.pumpMaxRunS)} per run at ${limits.pumpMaxDuty}% duty. Won't start below ${limits.waterLowCm == null ? '— cm' : withUnit(limits.waterLowCm, 'cm')} of water.` : undefined
  const notice = runOnce.error
    ? <span className="truncate text-danger" title={runOnce.error.message}>{runOnce.error.message}</span>
    : asked !== null && !p?.on ? <NotStarted asked={asked} onGiveUp={() => setAsked(null)} /> : null

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
          preview={previewing && previewRuns
            ? { label: `${previewRuns.length} × ${Math.round(previewing.durationS / 60)} min`, onApply: () => (cycles.length ? setConfirming(true) : apply()), onCancel: () => setPreview(null) }
            : null}
          source={p?.on ? runSource(runs.data ?? [], cycles, p.since) : null}
          limits={limitsLine}
          dur={dur}
          onDur={setDur}
          starting={asked !== null}
          notice={notice}
          stopping={stop.isPending}
          onRun={() => {
            setAsked(Date.now())
            runOnce.mutate({ durationS: Number(dur) })
          }}
          onStop={() => stop.mutate()}
        />
        {asked !== null && p?.on && <Started onSeen={() => setAsked(null)} />}
        <div className="flex flex-col gap-3.5 px-[22px] pb-5 pt-4">
          {flat
            ? (
                <>
                  <TankReadout tank={tank} capacityL={cfg?.tankCapacityL} />
                  <div className="relative h-2.5 rounded-full bg-line" role="meter" aria-label="Tank level" aria-valuenow={tank ?? 0} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full rounded-full bg-tank transition-[width] duration-700" style={{ width: `${tank ?? 0}%` }} />
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
                  preview={previewRuns}
                  tank={tank}
                  capacityL={cfg?.tankCapacityL}
                  cutoff={cutoff}
                  current={s.water_level_pct?.value ?? null}
                  run={p?.on ? { since: p.since } : null}
                  ran={(runs.data ?? []).filter(r => cycles.some(c => c.id === r.scheduleId)).map(r => r.firedAt)}
                  nowMin={now.getHours() * 60 + now.getMinutes()}
                  later={cycles.filter(c => c.enabled && dayOn(c.days, weekdayOf(now)) && c.spec.minute > now.getHours() * 60 + now.getMinutes()).map(c => c.spec.minute)}
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

      <div id="pump-cycles" className="flex scroll-mt-6 items-center gap-3">
        <h2 className={`${EYEBROW} flex-1`}>Pump cycles</h2>
        <Button icon={Plus} onClick={() => setEditing({ id: `pump-${Date.now().toString(36)}`, kind: 'pump', name: 'Watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })}>Add cycle</Button>
      </div>
      <PumpPresets
        light={light}
        recommended={recommended}
        sown={sown}
        previewing={preview}
        onPreview={(id) => {
          setPreview(id === preview ? null : id)
          // The preview reads on a day's axis.
          if (id !== preview) setHours('24')
        }}
        onBlank={() => setEditing({ id: `pump-${Date.now().toString(36)}`, kind: 'pump', name: 'Watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })}
      />
      {cycles.length > 0 && (
        <Card className="gap-0 p-0">
          {cycles.map(c => (
            <div key={c.id} className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-4 last:border-0">
              <span className={cn('w-[76px] font-mono text-xl font-medium', !c.enabled && 'text-fg-3')}>{fmtClock(c.spec.minute)}</span>
              <button type="button" className="flex min-w-[160px] flex-1 cursor-pointer flex-col gap-[3px] text-left" onClick={() => setEditing(c)}>
                <span className={cn('text-sm font-medium', !c.enabled && 'text-fg-2')}>{c.name}</span>
                <span className="text-[12px] text-fg-3">{[fmtMinutes(c.spec.durationS) + (c.spec.level ? ` at ${c.spec.level}%` : ''), daysLabel(c.days)].join(' · ')}</span>
              </button>
              <span className="font-mono text-[11px] text-fg-3">{cycleWhen(c, lastRun(c.id), now)}</span>
              <Toggle on={c.enabled} size="md" label={`Enable ${c.name}`} onChange={enabled => upsert.mutate({ ...c, enabled })} />
              <GhostIcon icon={MoreHorizontal} label={`Edit ${c.name}`} className="text-fg-3" onClick={() => setEditing(c)} />
            </div>
          ))}
        </Card>
      )}

      <Card className="py-3">
        <CareSummary />
      </Card>

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
        open={confirming && !!previewing}
        onClose={() => setConfirming(false)}
        title={`Replace the pump cycles with ${previewing?.name ?? ''}?`}
        icon={CalendarClock}
        footer={(
          <div className="flex gap-2">
            <Button variant="primary" onClick={apply}>Replace</Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        )}
      >
        <div className="flex flex-col gap-2 text-[13px] text-fg-2">
          <p>These go:</p>
          <ul className="flex flex-col gap-1 font-mono text-[12px]" data-testid="replaced-cycles">
            {cycles.map(c => <li key={c.id}>{`${fmtClock(c.spec.minute)} · ${c.name}`}</li>)}
          </ul>
          {previewing && previewRuns && <p>{`And ${previewing.name} runs ${previewRuns.map(fmtClock).join(', ')}, ${fmtMinutes(previewing.durationS)} each, every day.`}</p>}
        </div>
      </Modal>

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
              <SegmentedControl value={String(editing.spec.durationS) as typeof CYCLE_DURATIONS[number]} options={CYCLE_DURATIONS.map(d => ({ value: d, label: `${Number(d) / 60} min` }))} onChange={v => setEditing({ ...editing, spec: { ...editing.spec, durationS: Number(v) } })} />
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
function TankReadout({ tank, capacityL }: { tank: number | undefined, capacityL: number | undefined }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <span className="font-mono text-[44px] font-medium leading-none"><Pending loading={tank === undefined} sample="100%">{`${tank}%`}</Pending></span>
      {tank !== undefined && capacityL !== undefined && <span className="text-[13px] text-fg-2">{`≈ ${toDisplay(Math.round(capacityL * tank / 10) / 10, 'L').value} of ${withUnit(capacityL, 'L')}`}</span>}
    </div>
  )
}

/** Empty, the pump cutoff and full, under the meter or the scene. */
function TankScale({ cutoff, emptyCm, fullCm }: { cutoff: number | null, emptyCm: number | undefined, fullCm: number | undefined }) {
  return (
    <div className={AXIS}>
      <span>{emptyCm !== undefined ? `empty · ${withUnit(emptyCm, 'cm')}` : 'empty'}</span>
      {cutoff !== null && <span className="text-pod-ready">{`pump cutoff ${cutoff}%`}</span>}
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
function TankBody({ hours, onHours, preview, tank, capacityL, cutoff, current, run, ran, nowMin, later, marks, onUnavailable }: {
  hours: Hours
  onHours: (h: Hours) => void
  /** A preset's run times (minutes of the day) shown before it's applied. */
  preview: number[] | null
  tank: number | undefined
  capacityL: number | undefined
  cutoff: number | null
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
        currentPct: current,
        ticks,
        marks,
        pumping: !!run,
        runFrom,
        runs: ran.map(along),
        // Today's runs still to come only fit the day's own range, and give way to a preview.
        upcoming: t.h <= 24 && !preview ? later.map(m => (m - nowMin) / (1440 - nowMin)) : [],
        // A preview's runs at their time of day: each falls once in the last 24 h.
        preview: preview && t.h <= 24 && x1 > x0
          ? preview.map((m) => {
              const day = new Date(x1)
              day.setHours(0, 0, 0, 0)
              const at = day.getTime() + m * 60_000
              return ((at > x1 ? at - 86_400_000 : at) - x0) / (x1 - x0)
            })
          : [],
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
          <TankReadout tank={tank} capacityL={capacityL} />
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
        label={`Tank at ${tank ?? '—'}%, and its level over the last ${t.h <= 24 ? 'day' : t.h <= 168 ? 'week' : 'month'}${run ? ', with the pump running' : ''}`}
        message={status === 'error' ? `Couldn't load the tank history: ${t.q.error?.message ?? ''}` : 'No tank level recorded in this window.'}
        fallback={null}
        onUnavailable={onUnavailable}
      />
    </>
  )
}

/** A day in a line: the light's window as a faint amber band and each run a blue tick. */
function DayStrip({ runs, light }: { runs: number[], light: { on: number, off: number } | null }) {
  return (
    <svg viewBox="0 0 1440 14" preserveAspectRatio="none" className="block h-3.5 w-full" aria-hidden>
      <rect x={0} y={6} width={1440} height={2} className="fill-line" />
      {light && <rect x={light.on} y={0} width={light.off - light.on} height={14} className="fill-light/20" />}
      {runs.map(m => <rect key={m} x={m - 6} y={1} width={12} height={12} rx={2} className="fill-tank" />)}
    </svg>
  )
}

/**
 * Watering starting points by growth stage, as Light offers curves: each
 * with its day in a line, what it adds up to, the note behind it and a link
 * to the source, the one for this tower marked. Picking one previews it on
 * the chart and the strip; Apply there replaces the cycles. Blank opens the
 * editor.
 */
function PumpPresets({ light, recommended, sown, previewing, onPreview, onBlank }: {
  light: { on: number, off: number } | null
  recommended: PumpPresetId | null
  sown: number | null
  previewing: PumpPresetId | null
  onPreview: (id: PumpPresetId) => void
  onBlank: () => void
}) {
  return (
    <Card dashed className="gap-3">
      <p className="text-[13px] text-fg-2 text-pretty">
        {'Community starting points from r/Gardyn owners, not Gardyn’s: Gardyn doesn’t publish a watering cadence (its Smart Watering adjusts it), and waits a few days to a week after sowing before the second watering. '}
        <a href={GARDYN_WATERING_GUIDE} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">Gardyn’s guide</a>
        . Pick one to preview it on the chart; Apply replaces your cycles.
      </p>
      <div className="grid gap-2 min-[560px]:grid-cols-2 min-[900px]:grid-cols-5">
        {PUMP_PRESETS.map((p) => {
          const runs = presetRuns(p, light)
          const mins = Math.round(p.durationS / 60)
          const mine = recommended === p.id
          return (
            <div key={p.id} className={cn('flex flex-col gap-2 rounded-card border bg-surface px-3.5 py-3', previewing === p.id ? 'border-tank' : mine ? 'border-fg-3' : 'border-line')}>
              <button type="button" data-testid={`pump-preset-${p.id}`} aria-pressed={previewing === p.id} onClick={() => onPreview(p.id)} className="flex cursor-pointer flex-col gap-1.5 border-0 bg-transparent p-0 text-left">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                </span>
                {mine && <span className="w-fit rounded-[10px] bg-pod-ok/15 px-2 py-0.5 font-mono text-[10px] font-medium uppercase text-pod-ok" data-testid="pump-recommended">{p.id === 'fruiting' ? 'for your fruiting plants' : `for day ${sown}`}</span>}
                <DayStrip runs={runs} light={light} />
                <span className="font-mono text-[11px] text-fg-2">{`${runs.length} × ${mins} min = ${dailyMinutes(runs.length, p.durationS)} min a day`}</span>
                <span className="text-[12px] leading-snug text-fg-3">{p.note}</span>
              </button>
              <a href={p.citation.url} target="_blank" rel="noopener noreferrer" className="w-fit text-[12px] text-fg-3 underline decoration-line-2 underline-offset-2 hover:text-fg">{p.citation.section}</a>
            </div>
          )
        })}
        <button type="button" data-testid="pump-preset-blank" onClick={onBlank} className="flex cursor-pointer flex-col gap-1 rounded-card border border-dashed border-line-2 px-3.5 py-3 text-left hover:border-fg-3">
          <span className="text-sm font-medium">Blank</span>
          <span className="text-[12px] leading-snug text-fg-2">A run time and length of your own. Each run is bounded by the pump’s max run and refused when the tank is low.</span>
        </button>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-snug text-fg-3" data-testid="watering-tips">
        {WATERING_TIPS.map(tip => <li key={tip}>{tip}</li>)}
        <li className="list-none">
          <a href={TIPS_CITATION.url} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">{TIPS_CITATION.section}</a>
        </li>
      </ul>
    </Card>
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
function PumpStrip({ pump: p, at, readings: s, next, unscheduled, onSchedule, preview, source, limits, dur, onDur, starting, notice, stopping, onRun, onStop }: {
  pump: { on: boolean, level: number, since: string, fault: string | null, remainingS: number | null } | undefined
  at: number
  readings: Partial<Record<SensorId, Reading>>
  next: string | null
  /** No cycle will run: the subtitle says so and leads to the pump cycles. */
  unscheduled: boolean
  onSchedule: () => void
  /** A preset on show before it's applied. */
  preview: { label: string, onApply: () => void, onCancel: () => void } | null
  source: string | null
  limits: string | undefined
  dur: typeof DURATIONS[number]['value']
  onDur: (v: typeof DURATIONS[number]['value']) => void
  starting: boolean
  notice: ReactNode
  stopping: boolean
  onRun: () => void
  onStop: () => void
}) {
  const running = !!p?.on
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
                notice ?? (p?.fault
                  ? <span className="truncate">{p.fault}</span>
                  : preview
                    ? (
                        <span className="flex min-w-0 items-center gap-1.5 text-tank" data-testid="strip-preview">
                          <span className="truncate">{`Preview: ${preview.label}`}</span>
                          <span aria-hidden>·</span>
                          <button type="button" onClick={preview.onApply} className="shrink-0 cursor-pointer border-0 bg-transparent p-0 font-medium text-fg underline underline-offset-2">Apply</button>
                          <span aria-hidden>·</span>
                          <button type="button" onClick={preview.onCancel} className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-fg-2 underline underline-offset-2 hover:text-fg">Cancel</button>
                        </span>
                      )
                    : (
                        <span className="truncate">
                          {unscheduled && <button type="button" onClick={onSchedule} className="cursor-pointer border-0 bg-transparent p-0 text-fg-2 underline underline-offset-2 hover:text-fg">No watering schedule</button>}
                          {[unscheduled ? null : next, s.pump_v ? `supply ${fmt(s.pump_v)}` : null].filter(Boolean).map((t, i) => (unscheduled || i > 0 ? ` · ${t}` : t)).join('')}
                        </span>
                      )),
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
                guides={cutoff !== null ? [{ value: cutoff }] : []}
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

function NotStarted({ asked, onGiveUp }: { asked: number, onGiveUp: () => void }) {
  const now = useNow(1000)
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  if (now - asked < START_WAIT_MS) return null
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
