import { FastForward, Pause, Play, Sprout } from 'lucide-react'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, InlineError } from '@/src/components/ds/core'
import { WeekdayDots } from '@/src/components/ds/forms'
import { Modal } from '@/src/components/ds/feedback'
import { fmtClock } from '@/src/components/charts/format'
import { asCurve, levelAt, runningToday, type LightCurve } from '@/src/components/Light/curves'
import { DayStrip, SourceLink } from '@/src/components/Water/DayStrip'
import { asCycle, fmtDay, fmtMinutes } from '@/src/components/Water/pumpCycles'
import { SownOn } from '@/src/components/Water/SownOn'
import { followedPreset } from '@/src/care/follow'
import { daysLabel } from '@/src/lib/days'
import { BOOST_LEVEL, LIGHT_PRESETS } from '@/src/scheduler/lightPlan'
import { dailyMinutes, lightWindow, PUMP_PRESETS, type PumpPreset } from '@/src/scheduler/pumpPlan'
import { localTime, systemZone } from '@/src/scheduler/time'
import { trpc } from '@/src/utils/trpc'
import { nextStage, plainDay, stageDays, waterWords, whereWords, type ProtocolReport, type ProtocolStageView } from './protocolWords'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
/** The track's share for an ongoing stage, against the others' lengths in days. */
const ONGOING_FLEX = 14

type Light = { on: number, off: number } | null
const GERMINATION = PUMP_PRESETS.find(p => p.id === 'germination') as PumpPreset
type Picked = ProtocolStageView['id'] | 'then'

const hoursOf = (l: NonNullable<Light>) => Math.round((l.off - l.on) / 30) / 2

/** When today's curves hold the light at Boost, Gardyn's full brightness, from the first such minute to the last, to the quarter hour. */
function boostWindow(curves: LightCurve[]): Light {
  let on: number | null = null
  let off: number | null = null
  for (let m = 0; m < 1440; m++) {
    if (curves.some(c => levelAt(c.spec, m) >= BOOST_LEVEL)) {
      on ??= m
      off = m + 1
    }
  }
  const quarter = (m: number) => Math.round(m / 15) * 15
  return on === null || off === null ? null : { on: quarter(on), off: quarter(off) }
}
const short = (w: { runs: number[], durationS: number, weekly: boolean }) => `${w.runs.length}×${Math.round(w.durationS / 60)} min${w.weekly ? ' wk' : ''}`

/**
 * The grow protocol on Grow (ADR-0030): the stages as one track from the
 * sowing day with a Then slot at its end, Hold and Advance, and a panel for
 * the stage picked (the current one to start with) saying what it sets:
 * water, light, feed and checks, each with its source. A later stage says
 * when it starts and what changes; the Then slot chooses what comes after
 * maintenance. Hovering a stage only highlights it and says it in a line.
 */
export function ProtocolCard() {
  const utils = trpc.useUtils()
  const q = trpc.protocol.current.useQuery()
  const library = trpc.schedules.library.list.useQuery()
  const schedules = trpc.schedules.list.useQuery()
  const settings = trpc.settings.get.useQuery()
  const changed = () => {
    void utils.protocol.invalidate()
    void utils.schedules.invalidate()
  }
  const hold = trpc.protocol.hold.useMutation({ onSuccess: changed })
  const release = trpc.protocol.release.useMutation({ onSuccess: changed })
  const advance = trpc.protocol.advance.useMutation({ onSuccess: changed })
  const setThen = trpc.protocol.setThen.useMutation({ onSuccess: changed })
  const activate = trpc.schedules.library.activate.useMutation({ onSuccess: changed })
  // Moving the sowing day or starting germination changes the grow cycle and the pump cycles on the unit.
  const growChanged = () => {
    void utils.grow.invalidate()
    changed()
  }
  const setStart = trpc.grow.setStart.useMutation({ onSuccess: growChanged })
  const startGermination = trpc.grow.startGermination.useMutation({ onSuccess: () => {
    growChanged()
    setStarting(false)
  } })
  const [starting, setStarting] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [hovered, setHovered] = useState<Picked | null>(null)
  const [confirming, setConfirming] = useState(false)
  // The light curves running today on the unit's clock, for the light column and the day strips.
  const zone = settings.data?.timezone ?? systemZone()
  const curves = useMemo(() => (schedules.data ?? []).flatMap(x => asCurve(x) ?? []), [schedules.data])
  const now = new Date()
  const unitNow = localTime(now, zone)
  const running = runningToday(curves, unitNow.weekday)
  const light = lightWindow(running.map(c => c.spec))
  const boost = boostWindow(running)
  const today = unitNow.date
  const cycles = (schedules.data ?? []).flatMap(x => asCycle(x) ?? [])

  const r = q.data
  if (!r) return null
  const current = r.stages.find(s => s.id === r.stage) ?? null
  const shown: Picked | null = picked ?? current?.id ?? r.stages[0]?.id ?? null
  const next = nextStage(r)
  const own = (library.data ?? []).filter(e => e.kind === 'own')
  const thenEntry = r.then.scheduleId ? (library.data ?? []).find(e => e.id === r.then.scheduleId) ?? null : null
  const noCycle = r.cycleId === null
  // Follow is off, so germination's weekly run keeps its day when the sowing day moves: say so.
  const sowDay = r.sownOn ? (new Date(`${r.sownOn}T00:00:00Z`).getUTCDay() + 6) % 7 : null
  const germinating = followedPreset(cycles)?.id === 'germination' ? cycles[0] : undefined
  const stays = !r.following && germinating && sowDay !== null && germinating.days !== 1 << sowDay ? `Follow is off: your weekly run stays on ${daysLabel(germinating.days)}` : null
  const error = hold.error ?? release.error ?? advance.error ?? setThen.error ?? activate.error
  const summary = (id: Picked) => {
    if (id === 'then') return `Then · ${thenLabel(r, thenEntry)}`
    const s = r.stages.find(x => x.id === id)
    if (!s) return ''
    const when = s.state === 'next' && s.startsOn ? `starts ${plainDay(s.startsOn)}` : s.state === 'current' ? 'now' : s.startsOn ? `began ${plainDay(s.startsOn)}` : ''
    return [s.name, `days ${stageDays(s)}`, waterWords(s.water), when].filter(Boolean).join(' · ')
  }

  return (
    <section aria-label="Grow protocol" data-testid="protocol" className="flex flex-col rounded-[14px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h2 className="text-base font-semibold">{`${r.protocol.name} protocol`}</h2>
          <p className="text-[13px] text-fg-2" data-testid="protocol-where">{whereWords(r)}</p>
        </div>
        {r.hold
          ? <Button icon={Play} disabled={release.isPending} onClick={() => release.mutate()}>Release hold</Button>
          : <Button icon={Pause} disabled={noCycle || !current || hold.isPending} onClick={() => hold.mutate()}>Hold at this stage</Button>}
        <Button icon={FastForward} disabled={!r.canAdvance || advance.isPending} title={r.canAdvance ? undefined : current?.to === null ? 'Maintenance is the last stage and ongoing' : 'Needs an open cycle and planted pods'} onClick={() => setConfirming(true)}>Advance now</Button>
      </div>

      {(!r.following || noCycle || r.water === 'edited' || r.water === 'schedule' || error) && (
        <div className="flex flex-col gap-1.5 border-b border-line px-5 py-3 text-[13px] text-fg-2" data-testid="protocol-notes">
          {!r.following && <p>Follow the grow cycle is off on Water, so the protocol changes no watering; the first-harvest reminder still comes.</p>}
          {noCycle && <p>Start a cycle to hold, advance or choose what comes after; the stages count from the earliest pod for now.</p>}
          {r.water === 'edited' && <p>The pump cycles were changed by hand, so the protocol leaves them as they are.</p>}
          {r.water === 'schedule' && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{`On your schedule${(library.data ?? []).find(e => e.id === r.activeScheduleId)?.name ? ` ${(library.data ?? []).find(e => e.id === r.activeScheduleId)?.name}` : ''}: the protocol’s watering waits.`}</span>
              {current && <Button size="sm" disabled={activate.isPending} onClick={() => activate.mutate({ id: `preset:${current.water.presetId}` })}>{`Back to ${current.water.name}`}</Button>}
            </p>
          )}
          {error && <InlineError>{error.message}</InlineError>}
        </div>
      )}

      <div className="flex flex-col gap-2 px-5 py-4">
        {/* One row from the sowing day on a wide screen; a column of stages on a phone, so no name is cut to nothing. */}
        <div className="flex flex-col gap-1 min-[640px]:h-16 min-[640px]:flex-row" role="group" aria-label="Stages">
          {r.stages.map((s, i) => {
            const len = s.to === null ? ONGOING_FLEX : s.to - s.from + 1
            const on = shown === s.id
            const done = s.state === 'done'
            const progress = s.state === 'current' && s.to !== null && r.dayInStage !== null ? Math.min(1, (r.dayInStage + 1) / len) : null
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                data-state={s.state}
                onClick={() => setPicked(s.id)}
                onMouseEnter={() => setHovered(s.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(s.id)}
                onBlur={() => setHovered(null)}
                // Its length in days sets its share of the row; stacked on a phone, each takes its own height.
                style={{ '--len': len } as CSSProperties}
                className={cn(
                  'relative min-w-0 cursor-pointer overflow-hidden border px-2.5 py-2 text-left transition-colors min-[640px]:[flex:var(--len)_1_0%]',
                  i === 0 ? 'rounded-[8px] rounded-b-[4px] min-[640px]:rounded-[4px] min-[640px]:rounded-l-[8px]' : 'rounded-[4px]',
                  on ? 'border-fg-3 bg-active' : hovered === s.id ? 'border-line-2 bg-active/50' : 'border-line',
                  done && !on && 'opacity-70',
                )}
              >
                {progress !== null && <span aria-hidden className="absolute inset-y-0 left-0 bg-fg/10" style={{ width: `${progress * 100}%` }} />}
                <span className={cn('relative block truncate text-[13px]', s.state === 'current' ? 'font-semibold' : 'font-medium')}>{s.name}</span>
                <span className="relative mt-1 block truncate font-mono text-[11px] text-fg-3">{`${stageDays(s)} · ${short(s.water)}`}</span>
              </button>
            )
          })}
          <button
            type="button"
            aria-pressed={shown === 'then'}
            onClick={() => setPicked('then')}
            onMouseEnter={() => setHovered('then')}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered('then')}
            onBlur={() => setHovered(null)}
            className={cn('min-w-0 shrink-0 cursor-pointer rounded-[4px] rounded-b-[8px] border border-dashed px-2.5 py-2 text-left min-[640px]:basis-[150px] min-[640px]:rounded-[4px] min-[640px]:rounded-r-[8px]', shown === 'then' ? 'border-fg-3 bg-active' : hovered === 'then' ? 'border-line-2 bg-active/50' : 'border-line-2')}
          >
            <span className="block text-[13px] font-medium">Then</span>
            <span className="mt-1 block truncate font-mono text-[11px] text-pod-ok">{thenLabel(r, thenEntry)}</span>
          </button>
        </div>
        {/* The track's left end is the sowing day, with Change, or Start germination today with no cycle; its right end runs on. */}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1" data-testid="track-line">
          <SownOn
            sowDate={r.sownOn}
            cycle={r.cycleId ? 'open' : 'none'}
            today={today}
            note={stays}
            onChange={startedAt => setStart.mutateAsync({ startedAt })}
            onStartToday={() => {
              startGermination.reset()
              setStarting(true)
            }}
          />
          <span className="font-mono text-[11px] text-fg-3">ongoing</span>
        </div>
        <p className="min-h-[16px] truncate font-mono text-[11px] text-fg-2" data-testid="track-hover">{hovered ? summary(hovered) : ''}</p>
      </div>

      {shown === 'then'
        ? <ThenPanel r={r} own={own} thenEntry={thenEntry} light={light} boost={boost} busy={setThen.isPending} onSet={v => setThen.mutate(v)} />
        : <StagePanel stage={r.stages.find(s => s.id === shown) ?? null} r={r} light={light} boost={boost} />}

      <Modal
        open={confirming && !!next}
        onClose={() => setConfirming(false)}
        title={`Advance to ${next?.name ?? ''} now?`}
        icon={FastForward}
        footer={(
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={advance.isPending}
              onClick={() => {
                advance.mutate()
                setConfirming(false)
                setPicked(null)
              }}
            >
              Advance
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        )}
      >
        <p className="text-[13px] text-fg-2">{next?.change ? `${next.change} Later stages move up to match; the protocol never goes back a stage.` : 'Later stages move up to match; the protocol never goes back a stage.'}</p>
      </Modal>

      <Modal
        open={starting}
        // Not dismissed mid-call: it closes itself when the unit answers, or stays to say why not.
        onClose={() => {
          if (!startGermination.isPending) setStarting(false)
        }}
        title="Start germination today?"
        icon={Sprout}
        footer={(
          <div className="flex gap-2">
            <Button variant="primary" disabled={startGermination.isPending} onClick={() => startGermination.mutate()}>{startGermination.isPending ? 'Starting…' : 'Start'}</Button>
            <Button disabled={startGermination.isPending} onClick={() => setStarting(false)}>Cancel</Button>
          </div>
        )}
      >
        <div className="flex flex-col gap-2 text-[13px] text-fg-2" data-testid="start-germination">
          <p>{`A grow cycle starts today, ${fmtDay(now, zone)}, and watering moves to ${GERMINATION.name}: ${fmtMinutes(GERMINATION.durationS)} at ${fmtClock(GERMINATION.minutes[0] ?? 0)}, once a week on ${daysLabel(1 << unitNow.weekday)}.`}</p>
          {cycles.length > 0 && (
            <>
              <p>These go:</p>
              <ul className="flex flex-col gap-1 font-mono text-[12px]">
                {cycles.map(c => <li key={c.id}>{`${fmtClock(c.spec.minute)} · ${c.name}`}</li>)}
              </ul>
            </>
          )}
          {startGermination.error && <InlineError>{`Couldn't start germination: ${startGermination.error.message}`}</InlineError>}
        </div>
      </Modal>
    </section>
  )
}

/** What the Then slot says it will do. */
function thenLabel(r: ProtocolReport, entry: { name: string, cycles: Array<{ durationS: number }> } | null): string {
  if (r.then.kind === 'remind') return 'remind at first harvest'
  if (r.then.kind === 'schedule') return entry ? `${entry.name} · ${entry.cycles.length}×${Math.round((entry.cycles[0]?.durationS ?? 0) / 60)} min` : 'your schedule'
  return 'stay in maintenance'
}

/** One of the panel's four columns. */
function Column({ title, children }: { title: string, children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-surface px-5 py-4">
      <h3 className={EYEBROW}>{title}</h3>
      {children}
    </div>
  )
}

/** The light at full brightness today, or the preset a stage or schedule sets. */
function LightColumn({ boost, presetName }: { boost: Light, presetName: string | null }) {
  return (
    <Column title="Light">
      <span className="text-sm font-medium">{presetName ?? (boost ? `${hoursOf(boost)} h · ${fmtClock(boost.on)}–${fmtClock(boost.off)}` : 'No light at full brightness today')}</span>
      <span className="text-[12px] leading-snug text-fg-2">{presetName ? 'Set by this stage.' : 'Unchanged: the protocol leaves your light curves as they are.'}</span>
    </Column>
  )
}

/** What a stage sets, with where each comes from; a later stage says when it starts and what changes. */
function StagePanel({ stage: s, r, light, boost }: { stage: ProtocolStageView | null, r: ProtocolReport, light: Light, boost: Light }) {
  if (!s) return null
  const length = s.to === null ? null : s.to - s.from + 1
  const head = s.state === 'current'
    ? `${s.name} · ${r.dayInStage === null ? '' : `day ${r.dayInStage + 1}${length === null ? ', ongoing' : ` of ${length}`}`}`
    : s.state === 'next'
      ? `Starts ${s.startsOn ? plainDay(s.startsOn) : `on day ${s.from}`}${s.change ? ` · ${s.change}` : ''}`
      : `${s.name} · began ${s.startsOn ? plainDay(s.startsOn) : `day ${s.from}`}`
  return (
    <div className="flex flex-col border-t border-line" data-testid="stage-panel" aria-label={`${s.name} stage`}>
      <p className="px-5 pt-3.5 text-[13px] font-medium" data-testid="stage-head">{head}</p>
      {/* The gaps show the line between columns, however many fit across. */}
      <div className="grid grid-cols-1 gap-px bg-line min-[640px]:grid-cols-2 min-[1000px]:grid-cols-4">
        <Column title="Water">
          <span className="text-sm font-medium">{waterWords(s.water)}</span>
          <WeekdayDots days={s.water.days} />
          <DayStrip runs={s.water.runs} light={light} />
          <span className="font-mono text-[11px] text-fg-2" data-testid="stage-runs">
            {`${s.water.runs.map(fmtClock).join(', ')} · `}
            <span className="whitespace-nowrap">{s.water.weekly ? 'once a week' : `= ${dailyMinutes(s.water.runs.length, s.water.durationS)} min a day`}</span>
          </span>
          <SourceLink href={s.water.citation.url} className="text-[12px] text-fg-3">{s.water.citation.section}</SourceLink>
        </Column>
        <LightColumn boost={boost} presetName={s.light?.name ?? null} />
        <Column title="Feed">
          <span className="text-[13px] leading-snug">{s.feed.text}</span>
          <SourceLink href={s.feed.citation.url} className="text-[12px] text-fg-3">{s.feed.citation.section}</SourceLink>
        </Column>
        <Column title="Checks">
          <ul className="flex flex-col gap-2">
            {s.checks.map(c => (
              <li key={c.text} className="flex flex-col gap-0.5">
                <span className="text-[13px] leading-snug">{c.text}</span>
                <SourceLink href={c.citation.url} className="text-[12px] text-fg-3">{c.citation.section}</SourceLink>
              </li>
            ))}
          </ul>
        </Column>
      </div>
      <p className="flex flex-wrap gap-x-2 border-t border-line px-5 py-3 text-[12px] leading-snug text-fg-2">
        <span>{s.rationale}</span>
        <SourceLink href={s.citation.url} className="text-fg-3">{s.citation.section}</SourceLink>
      </p>
    </div>
  )
}

interface Own { id: string, name: string, cycles: Array<{ minute: number, durationS: number, days: number }>, lightPresetId: string | null }

/** What comes after maintenance: stay, one of your schedules (when maintenance begins, or now), or a reminder at first harvest. */
function ThenPanel({ r, own, thenEntry, light, boost, busy, onSet }: {
  r: ProtocolReport
  own: Own[]
  thenEntry: Own | null
  light: Light
  boost: Light
  busy: boolean
  onSet: (v: { kind: 'stay' | 'schedule' | 'remind', scheduleId?: string, when: 'now' | 'maintenance' }) => void
}) {
  const last = r.stages.at(-1)
  const [choice, setChoice] = useState<string>(r.then.scheduleId ?? own[0]?.id ?? '')
  const disabled = r.cycleId === null || busy
  const inMaintenance = r.stage === last?.id
  const pickedSchedule = own.find(e => e.id === choice) ?? null
  const shown = r.then.kind === 'schedule' ? thenEntry : null
  const option = (kind: 'stay' | 'schedule' | 'remind', title: string, sub: ReactNode, extra?: ReactNode, off = false) => (
    <label className={cn('flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3.5 py-3', r.then.kind === kind ? 'border-pod-ok/60 bg-pod-ok/5' : 'border-line', (disabled || off) && 'cursor-default opacity-60')}>
      <input
        type="radio"
        name="protocol-then"
        className="mt-0.5 accent-current"
        checked={r.then.kind === kind}
        disabled={disabled || off}
        onChange={() => (kind === 'schedule' ? pickedSchedule && onSet({ kind, scheduleId: pickedSchedule.id, when: 'maintenance' }) : onSet({ kind, when: 'maintenance' }))}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-[12px] leading-snug text-fg-2">{sub}</span>
        {extra}
      </span>
    </label>
  )
  return (
    <div className="flex flex-col border-t border-line" data-testid="then-panel">
      <fieldset className="m-0 flex flex-col gap-3 border-0 px-5 py-4">
        <legend className="mb-2 text-sm font-medium">
          After the stages
          <span className="ml-2 font-mono text-[12px] font-normal text-fg-3">{last ? `${last.name} is ongoing; nothing changes unless you choose` : ''}</span>
        </legend>
        <div className="grid grid-cols-1 gap-2.5 min-[720px]:grid-cols-3">
          {option('stay', 'Stay in maintenance', last ? `${waterWords(last.water)}, for as long as the plants grow.` : 'Keep the last stage.')}
          {option(
            'schedule',
            'Switch to my schedule',
            own.length ? (inMaintenance ? 'Maintenance has begun, so this switches now.' : 'When maintenance begins, or now.') : 'Save a schedule of your own first.',
            own.length > 0 && (
              <span className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Schedule to switch to"
                  value={choice}
                  disabled={disabled}
                  onChange={(e) => {
                    setChoice(e.target.value)
                    if (r.then.kind === 'schedule') onSet({ kind: 'schedule', scheduleId: e.target.value, when: 'maintenance' })
                  }}
                  className="rounded-[6px] border border-line-2 bg-bg px-2 py-1 font-mono text-[12px]"
                >
                  {own.map(e => <option key={e.id} value={e.id}>{`${e.name} · ${e.cycles.length}×${Math.round((e.cycles[0]?.durationS ?? 0) / 60)} min`}</option>)}
                </select>
                {!inMaintenance && pickedSchedule && <Button size="sm" disabled={disabled} onClick={() => onSet({ kind: 'schedule', scheduleId: pickedSchedule.id, when: 'now' })}>Switch now</Button>}
              </span>
            ),
            own.length === 0,
          )}
          {option('remind', 'Remind me at first harvest', r.then.harvestOn ? `In Needs you on ${plainDay(r.then.harvestOn)}, the planted crops’ first harvest by the catalog.` : 'No planted crop is in the catalog, so there’s no day to remind on.', null, r.then.harvestOn === null)}
        </div>
        {r.then.done && <p className="text-[12px] text-fg-3" data-testid="then-done">{r.then.kind === 'remind' ? 'Reminded: it’s in Needs you.' : 'Switched.'}</p>}
      </fieldset>
      {shown && (
        <div className="grid grid-cols-1 gap-px border-t border-line bg-line min-[640px]:grid-cols-2" data-testid="then-schedule">
          <Column title={`Water · ${shown.name}`}>
            <span className="text-sm font-medium">{`${shown.cycles.length} × ${shown.cycles.map(c => `${Math.round(c.durationS / 60)} min`).filter((x, i, a) => a.indexOf(x) === i).join(' / ')}`}</span>
            <WeekdayDots days={shown.cycles.reduce((m, c) => m | c.days, 0)} />
            <DayStrip runs={shown.cycles.map(c => c.minute)} light={light} />
            <span className="font-mono text-[11px] text-fg-2">{shown.cycles.map(c => fmtClock(c.minute)).join(', ')}</span>
          </Column>
          <LightColumn boost={boost} presetName={LIGHT_PRESETS.find(p => p.id === shown.lightPresetId)?.name ?? null} />
        </div>
      )}
    </div>
  )
}
