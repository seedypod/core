import { CalendarClock, ChevronDown, ChevronUp, Clock, Hand, Plus, Wand2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, GhostIcon } from '@/src/components/ds/core'
import { Slider, Toggle } from '@/src/components/ds/forms'
import { LineChart } from '@/src/components/ds/charts'
import { fmtClock } from '@/src/components/charts/format'
import { Chart3D, ChartNote, LoadingLine, Pending, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { lightData } from '@/src/components/charts/viz3d/shape'
import { daysLabel, weekdayOf } from '@/src/lib/days'
import { boostHours, GARDYN_LIGHT_GUIDE, LIGHT_PRESETS, lightRating } from '@/src/scheduler/lightPlan'
import { trpc } from '@/src/utils/trpc'
import { CurveEditor } from './CurveEditor'
import { useLightControl } from './useLightControl'
import { asCurve, levelAt, litHours, runningToday, SAMPLE_MINUTES, todayLevels, type LightCurve } from './curves'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
const AXIS = 'flex justify-between font-mono text-[10px] text-fg-3'
/** Gardyn's ratings: Great is the aim; Low and Too much want hours added or taken away. */
const RATING_TONE: Record<ReturnType<typeof lightRating>, string> = { 'low': 'bg-pod-attention/15 text-pod-attention', 'ok': 'bg-pod-ready/15 text-pod-ready', 'great': 'bg-pod-ok/15 text-pod-ok', 'intense': 'bg-pod-ready/15 text-pod-ready', 'too much': 'bg-pod-attention/15 text-pod-attention' }
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function LightPage() {
  const { light: l, level, requested, lightOn, preview, commit, power } = useLightControl()
  const schedules = trpc.schedules.list.useQuery()
  const utils = trpc.useUtils()
  const owner = trpc.light.owner.useQuery(undefined, { refetchInterval: 15_000 })
  const resume = trpc.light.resume.useMutation({ onSuccess: () => utils.light.invalidate() })
  const o = owner.data
  const upsert = trpc.schedules.upsert.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const lightHours = trpc.telemetry.lightHours.useQuery()
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const settings = trpc.settings.get.useQuery()
  const timezone = settings.data?.timezone
  const curves = (schedules.data ?? []).flatMap(s => asCurve(s) ?? [])
  const now = new Date()
  const minutesNow = now.getHours() * 60 + now.getMinutes()
  const running = runningToday(curves, weekdayOf(now))
  const today = todayLevels(running)
  // With nothing picked, the first curve running today is the open one.
  const open = openId ?? running[0]?.id ?? null
  const nowAt = minutesNow / 15
  const queries = [schedules, { data: l }]
  const status = vizStatus(queries, today === null)
  const scene = status === 'ready' && today
    ? lightData({ planned: today, nowMin: minutesNow + now.getSeconds() / 60, level: l?.on ? l.level : 0, hold: o?.source === 'manual' && o.manualUntil && l ? holdWindow(l.since, o.manualUntil, now) : null })
    : null

  const following = running.length === 1 ? `Following ${running[0]?.name}` : running.length > 1 ? `Following ${running.length} curves` : 'No curve today'
  const holding = o?.source === 'manual' && o.manualUntil ? `held by hand until ${clock(o.manualUntil)}` : o?.source === 'autopilot' ? 'Autopilot is in charge' : null

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Light</h1>
          <p className="text-[13px] text-fg-2">{[following, holding].filter(Boolean).join(' · ')}</p>
        </div>
        <span className="flex items-center gap-2.5 text-[13px] text-fg-2">
          {lightOn ? 'Lights on' : 'Lights off'}
          <Toggle on={lightOn} size="md" label="Light power" onChange={power} />
        </span>
      </div>

      <Card className="gap-5 p-[22px]">
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-[140px] flex-col gap-1">
            <span className="font-mono text-[44px] font-medium leading-none"><Pending loading={!l} sample="100%">{l && (l.on || requested ? `${level}%` : 'Off')}</Pending></span>
            <span className="text-[12px] text-fg-3">{l ? `since ${clock(l.since)}` : <LoadingLine />}</span>
          </div>
          <div className="flex min-w-[260px] flex-1 flex-col gap-3 pt-2">
            <Slider
              value={level}
              onChange={preview}
              onCommit={commit}
              label="Brightness"
            />
            <div className={AXIS} aria-hidden>
              <span>off</span>
              <span>50</span>
              <span>100%</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-active/60 px-3.5 py-2.5 text-[13px] text-fg-2">
          {o?.source === 'manual' ? <Hand size={16} /> : o?.source === 'autopilot' ? <Wand2 size={16} /> : <CalendarClock size={16} />}
          <span className="min-w-[200px] flex-1">
            {o?.source === 'manual'
              ? `Your change holds until ${clock(o.manualUntil ?? '')}. Then ${o.schedule !== null ? `the curve (${o.schedule}% at this hour)` : 'the curve or Autopilot'} takes over again.`
              : o?.source === 'autopilot'
                ? 'Autopilot is setting the light. A change here holds for 30 minutes.'
                : 'Following the curve. A change here holds for 30 minutes.'}
          </span>
          {o?.source === 'manual' && <Button disabled={resume.isPending} onClick={() => resume.mutate()}>Resume curve</Button>}
        </div>

        <div className="flex flex-col gap-2">
          <div className={`${EYEBROW} flex items-center justify-between gap-3 text-[10px]`}>
            <span className="flex items-center gap-3">
              Today
              <ChartNote status={status} stale={staleSince(queries)} onRetry={() => void schedules.refetch()} />
            </span>
            {lightHours.data && (
              <span data-testid="led-hours">{`LED life ${Math.round(Math.max(0, 100 - lightHours.data.pctUsed))}% · ${Math.round(lightHours.data.hours).toLocaleString()} / ${lightHours.data.ratedHours.toLocaleString()} h`}</span>
            )}
          </div>
          <Chart3D
            kind="light"
            data={scene}
            status={status}
            label={`Today's light: the curve planned, what the LED has given so far${o?.source === 'manual' ? ', and the manual hold' : ''}`}
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
                      markers={[{ at: nowAt, label: `now ${fmtClock(minutesNow)}` }]}
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
            {'Gardyn recommends 14–16 hours a day at full brightness (Boost); dimmed hours don’t count, 17 or more stress the plants, and nights need unbroken dark. '}
            <a href={GARDYN_LIGHT_GUIDE} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">Gardyn’s guide</a>
            {curves.length === 0 ? '. Start from one of these:' : '. Start from:'}
          </p>
          <div className="grid gap-2 min-[720px]:grid-cols-4">
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
          onOpen={next => setOpenId(next ? c.id : '')}
          onSave={next => upsert.mutate(next)}
        />
      ))}
    </div>
  )
}

/** A manual hold's window today in minutes: from when the light was set (or midnight) until it hands back (or midnight). */
export function holdWindow(sinceIso: string, untilIso: string, now: Date): { fromMin: number, untilMin: number } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const minutes = (iso: string) => Math.max(0, Math.min(1440, (Date.parse(iso) - midnight) / 60_000))
  return { fromMin: minutes(sinceIso), untilMin: minutes(untilIso) }
}

function CurveCard({ curve: c, running, open, onOpen, onSave }: { curve: LightCurve, running: boolean, open: boolean, onOpen: (open: boolean) => void, onSave: (next: LightCurve) => void }) {
  const n = c.spec.setpoints.length
  const boost = boostHours(c.spec)
  const meta = [`${n} setpoint${n === 1 ? '' : 's'}`, daysLabel(c.days), c.enabled ? `${litHours(c.spec)} h of light, ${boost} h at full` : 'off'].join(' · ')
  const rating = lightRating(boost)
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
        <Toggle on={c.enabled} size="md" label={`Enable ${c.name}`} onChange={enabled => onSave({ ...c, enabled })} />
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
