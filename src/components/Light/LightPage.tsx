import { CalendarClock, ChevronDown, ChevronUp, Hand, Plus, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, GhostIcon } from '@/src/components/ds/core'
import { Slider, Toggle } from '@/src/components/ds/forms'
import { LineChart } from '@/src/components/ds/charts'
import { fmtClock } from '@/src/components/charts/format'
import { daysLabel, weekdayOf } from '@/src/lib/days'
import { trpc } from '@/src/utils/trpc'
import { CurveEditor } from './CurveEditor'
import { asCurve, levelAt, litHours, runningToday, SAMPLE_MINUTES, todayLevels, type LightCurve } from './curves'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
const AXIS = 'flex justify-between font-mono text-[10px] text-fg-3'
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function LightPage() {
  const light = trpc.light.get.useQuery()
  const schedules = trpc.schedules.list.useQuery()
  const utils = trpc.useUtils()
  const setLight = trpc.light.set.useMutation({ onSuccess: () => utils.light.invalidate() })
  const owner = trpc.light.owner.useQuery(undefined, { refetchInterval: 15_000 })
  const resume = trpc.light.resume.useMutation({ onSuccess: () => utils.light.invalidate() })
  const o = owner.data
  const upsert = trpc.schedules.upsert.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const lightHours = trpc.telemetry.lightHours.useQuery()
  const [draft, setDraft] = useState<number | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const l = light.data
  const level = draft ?? l?.level ?? 0
  const curves = (schedules.data ?? []).flatMap(s => asCurve(s) ?? [])
  const now = new Date()
  const minutesNow = now.getHours() * 60 + now.getMinutes()
  const running = runningToday(curves, weekdayOf(now))
  const today = todayLevels(running)
  // With nothing picked, the first curve running today is the open one.
  const open = openId ?? running[0]?.id ?? null
  const nowAt = minutesNow / 15

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
          {l?.on ? 'Lights on' : 'Lights off'}
          <Toggle on={!!l?.on} size="md" label="Light power" onChange={on => setLight.mutate({ on })} />
        </span>
      </div>

      <Card className="gap-5 p-[22px]">
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-[140px] flex-col gap-1">
            <span className="font-mono text-[44px] font-medium leading-none">{l ? (l.on ? `${l.level}%` : 'Off') : '…'}</span>
            <span className="text-[12px] text-fg-3">{l ? `since ${clock(l.since)}` : '…'}</span>
          </div>
          <div className="flex min-w-[260px] flex-1 flex-col gap-3 pt-2">
            <Slider
              value={level}
              onChange={setDraft}
              onCommit={(v) => {
                setDraft(null)
                setLight.mutate({ level: v })
              }}
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
          <div className={`${EYEBROW} flex justify-between text-[10px]`}>
            <span>Today</span>
            {lightHours.data && (
              <span data-testid="led-hours">{`LED life ${Math.round(Math.max(0, 100 - lightHours.data.pctUsed))}% · ${Math.round(lightHours.data.hours).toLocaleString()} / ${lightHours.data.ratedHours.toLocaleString()} h`}</span>
            )}
          </div>
          {today
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
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <h2 className={`${EYEBROW} flex-1`}>Curves</h2>
        <Button
          icon={Plus}
          onClick={() => {
            const id = `curve-${Date.now().toString(36)}`
            upsert.mutate({ id, kind: 'light', name: 'New curve', enabled: false, days: 127, spec: { setpoints: [{ minute: 420, level: 0 }, { minute: 480, level: 80 }, { minute: 1200, level: 80 }, { minute: 1260, level: 0 }] } })
            setOpenId(id)
          }}
        >
          Add curve
        </Button>
      </div>
      {curves.length === 0 && <Card dashed><p className="text-[13px] text-fg-2">No curves yet. A curve is a set of setpoints by time of day; brightness ramps between them, so sunrise and sunset are free.</p></Card>}
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

function CurveCard({ curve: c, running, open, onOpen, onSave }: { curve: LightCurve, running: boolean, open: boolean, onOpen: (open: boolean) => void, onSave: (next: LightCurve) => void }) {
  const n = c.spec.setpoints.length
  const meta = [`${n} setpoint${n === 1 ? '' : 's'}`, daysLabel(c.days), c.enabled ? `${litHours(c.spec)} h of light` : 'off'].join(' · ')
  return (
    <Card className="gap-0 p-0">
      <div className="flex flex-wrap items-center gap-4 px-5 py-[18px]">
        <button type="button" className="flex min-w-[200px] flex-1 cursor-pointer flex-col gap-[3px] text-left" onClick={() => onOpen(!open)}>
          <span className="flex items-center gap-2">
            <span className={c.enabled ? 'text-[15px] font-medium' : 'text-[15px] font-medium text-fg-2'}>{c.name}</span>
            {running && <Badge variant="active" />}
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
