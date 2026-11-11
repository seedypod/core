import { withUnit } from '@/src/lib/sensorMeta'
import { toDisplay } from '@/src/lib/units'
import { CalendarClock, MoreHorizontal, Play, Plus, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, GhostIcon, InlineError, Skeleton } from '@/src/components/ds/core'
import { LineChart } from '@/src/components/ds/charts'
import { DayPicker, SegmentedControl, TextField, Toggle } from '@/src/components/ds/forms'
import { Modal } from '@/src/components/ds/feedback'
import { fmtClock, fmtDate, fmtTime } from '@/src/components/charts/format'
import { bin } from '@/src/components/charts/TimeChart'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { daysLabel, daysToList, listToDays } from '@/src/lib/days'
import { trpc } from '@/src/utils/trpc'
import { asCycle, cutoffPct, cycleWhen, fmtCountdown, fmtMinutes, fmtWhen, nextRun, tankTrend, type PumpCycle } from './pumpCycles'
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
  const p = pump.data
  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const limits = system.data?.system?.limits
  const cfg = settings.data
  const tank = s.water_level_pct && Math.round(s.water_level_pct.value)
  const cutoff = cutoffPct(limits?.waterLowCm, cfg?.waterFullCm, cfg?.waterEmptyCm)
  const cycles = (schedules.data ?? []).flatMap(x => asCycle(x) ?? []).sort((a, b) => a.spec.minute - b.spec.minute)
  const now = new Date()
  const next = nextRun(cycles, now)
  const lastRun = (id: string) => {
    const r = (runs.data ?? []).find(r => r.scheduleId === id)
    return r ? new Date(r.firedAt) : null
  }
  const isNew = !!editing && !cycles.some(c => c.id === editing.id)

  const pumpLine = p ? (p.on ? `watering at ${p.level}%` : p.fault ? `pump fault: ${p.fault}` : 'pump idle') : '…'
  const subtitle = [tank === undefined ? null : `Tank ${tank}%`, pumpLine, next ? `next run ${fmtClock(next.cycle.spec.minute)}` : null].filter(Boolean).join(' · ')

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Water</h1>
        <div className="flex flex-wrap items-center gap-3">
          <p className={cn('text-[13px]', p?.fault ? 'text-danger' : 'text-fg-2')}>{subtitle}</p>
          {p?.fault && <ClearFault />}
        </div>
      </div>

      <Card tone={p?.fault ? 'danger' : undefined} className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-7 p-[22px]">
        <div className="flex flex-col gap-3.5">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-[44px] font-medium leading-none">{tank === undefined ? '…' : `${tank}%`}</span>
            {tank !== undefined && cfg && <span className="text-[13px] text-fg-2">{`≈ ${toDisplay(Math.round(cfg.tankCapacityL * tank / 10) / 10, 'L').value} of ${withUnit(cfg.tankCapacityL, 'L')}`}</span>}
          </div>
          <div className="relative h-2.5 rounded-full bg-line" role="meter" aria-label="Tank level" aria-valuenow={tank ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-tank transition-[width] duration-700" style={{ width: `${tank ?? 0}%` }} />
            {cutoff !== null && <div className="absolute -top-1 h-[18px] w-px bg-pod-ready" style={{ left: `${cutoff}%` }} />}
          </div>
          <div className={AXIS}>
            <span>{cfg ? `empty · ${withUnit(cfg.waterEmptyCm, 'cm')}` : 'empty'}</span>
            {cutoff !== null && <span className="text-pod-ready">{`pump cutoff ${cutoff}%`}</span>}
            <span>{cfg ? `full · ${withUnit(cfg.waterFullCm, 'cm')}` : 'full'}</span>
          </div>
          <div className="flex flex-wrap gap-5 border-t border-line pt-2.5 font-mono text-[12px] text-fg-3">
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
        </div>
        <div className="flex flex-col gap-3">
          {p?.on
            ? <RunTrack since={p.since} remainingS={p.remainingS} at={pump.dataUpdatedAt} stopping={stop.isPending} onStop={() => stop.mutate()} />
            : (
                <>
                  <h2 className={EYEBROW}>Run now</h2>
                  <SegmentedControl full value={dur} onChange={setDur} options={DURATIONS.map(d => ({ value: d.value, label: d.label }))} ariaLabel="Run length" />
                  <Button
                    full
                    variant="primary"
                    icon={Play}
                    className="py-2.5 text-sm"
                    disabled={!!p?.fault || asked !== null}
                    onClick={() => {
                      setAsked(Date.now())
                      runOnce.mutate({ durationS: Number(dur) })
                    }}
                  >
                    {asked !== null ? 'Starting…' : 'Run pump'}
                  </Button>
                </>
              )}
          {runOnce.error && <InlineError>{runOnce.error.message}</InlineError>}
          {asked !== null && !p?.on && <NotStarted asked={asked} onGiveUp={() => setAsked(null)} />}
          {asked !== null && p?.on && <Started onSeen={() => setAsked(null)} />}
          {limits && <p className="text-[12px] leading-normal text-fg-3 text-pretty">{`Up to ${fmtMinutes(limits.pumpMaxRunS)} per run at ${limits.pumpMaxDuty}% duty. Won't start below ${limits.waterLowCm == null ? '— cm' : withUnit(limits.waterLowCm, 'cm')} of water.`}</p>}
        </div>
      </Card>

      <Card className="py-3">
        <CareSummary />
      </Card>

      <div className="flex items-center gap-3">
        <h2 className={`${EYEBROW} flex-1`}>Pump cycles</h2>
        <Button icon={Plus} onClick={() => setEditing({ id: `pump-${Date.now().toString(36)}`, kind: 'pump', name: 'Watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })}>Add cycle</Button>
      </div>
      {cycles.length === 0
        ? <Card dashed><p className="text-[13px] text-fg-2">No pump cycles. Each run is bounded by the hardware max-run and refused when the tank is low.</p></Card>
        : (
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

      <TankHistory cutoff={cutoff} />

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

/** Tank level over a range, with each top-up marked and the drain rate between them. */
function TankHistory({ cutoff }: { cutoff: number | null }) {
  const [hours, setHours] = useState<typeof RANGES[number]['value']>('168')
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

/** The run-length stops, in seconds, as ticks on the running track. */
const STOPS = DURATIONS.map(d => Number(d.value))

/**
 * While the pump runs, the duration picker becomes its track: the same stops as
 * ticks, filled as far as the run has got, the time left above it and Stop
 * below, so nothing jumps when a run starts.
 */
function RunTrack({ since, remainingS, at, stopping, onStop }: { since: string, remainingS: number | null, at: number, stopping: boolean, onStop: () => void }) {
  const run = useRun(since, remainingS, at)
  const span = Math.max(STOPS[STOPS.length - 1] ?? 900, run?.total ?? 0)
  const pct = (s: number) => `${Math.min(100, (s / span) * 100)}%`
  const elapsed = run ? run.total - run.left : 0
  return (
    <div className="flex flex-col gap-3" data-testid="run-track">
      <div className="flex items-baseline justify-between">
        <h2 className={cn(EYEBROW, 'flex items-center gap-2 text-tank')}>
          <span className="size-2 animate-pulse rounded-full bg-tank" />
          Watering
        </h2>
        {run && <span className="font-mono text-[15px] text-fg">{`${fmtCountdown(run.left)} left`}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="relative h-[46px] overflow-hidden rounded-ctl border border-line-2 bg-field" role="progressbar" aria-label="Watering" aria-valuenow={run ? Math.round(run.done) : undefined} aria-valuemin={0} aria-valuemax={100}>
          {run && <div className="absolute inset-y-0 left-0 bg-tank/25 transition-[width] duration-1000 ease-linear" style={{ width: pct(elapsed) }} />}
          {STOPS.slice(0, -1).map(s => <span key={s} className="absolute inset-y-0 w-px bg-line-2" style={{ left: pct(s) }} />)}
          {run && <span className="absolute inset-y-0 w-0.5 bg-tank transition-[left] duration-1000 ease-linear" style={{ left: pct(elapsed) }} />}
        </div>
        <div className="relative h-4 font-mono text-[11px] text-fg-3">
          {STOPS.map((s, i) => {
            const last = i === STOPS.length - 1
            const label = `${s / 60}${last ? ' min' : ''}`
            const mine = run && Math.abs(run.total - s) < 30
            return <span key={s} className={cn('absolute', last ? 'right-0' : '-translate-x-1/2', mine && 'text-fg')} style={last ? undefined : { left: pct(s) }}>{label}</span>
          })}
        </div>
      </div>
      <Button full icon={Square} className="py-2.5 text-sm" disabled={stopping} onClick={onStop} data-testid="stop-pump">Stop pump</Button>
    </div>
  )
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
  return (
    <InlineError>
      {`Didn't start: ${why}. `}
      <button type="button" className="cursor-pointer border-0 bg-transparent p-0 underline" onClick={onGiveUp}>Try again</button>
    </InlineError>
  )
}
