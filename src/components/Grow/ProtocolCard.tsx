import { Droplets, FastForward, Pause, Play, Sprout } from 'lucide-react'
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, InlineError } from '@/src/components/ds/core'
import { TextField, Toggle, WeekdayDots } from '@/src/components/ds/forms'
import { Modal } from '@/src/components/ds/feedback'
import { fmtClock } from '@/src/components/charts/format'
import { asCurve, runningToday } from '@/src/components/Light/curves'
import { DayStrip, SourceLink } from '@/src/components/Water/DayStrip'
import { asCycle, fmtDay, fmtMinutes } from '@/src/components/Water/pumpCycles'
import { SownOn } from '@/src/components/Water/SownOn'
import { followedPreset } from '@/src/care/follow'
import { daysLabel } from '@/src/lib/days'
import { BOOST_LEVEL, LIGHT_PRESETS } from '@/src/scheduler/lightPlan'
import { dailyMinutes, GARDYN_WATERING_GUIDE, lightPeriods, lightWindow, PUMP_PRESETS, TIPS_CITATION, WATERING_TIPS, type PumpPreset } from '@/src/scheduler/pumpPlan'
import { localTime, systemZone } from '@/src/scheduler/time'
import { trpc } from '@/src/utils/trpc'
import { nextStage, plainDay, stageDays, stageDayWords, waterWords, whereWords, type ProtocolReport, type ProtocolStageView } from './protocolWords'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
/** The track's share for an ongoing stage, against the others' lengths in days. */
const ONGOING_FLEX = 14

type Light = { on: number, off: number } | null
type Period = NonNullable<Light>
const GERMINATION = PUMP_PRESETS.find(p => p.id === 'germination') as PumpPreset
type Picked = ProtocolStageView['id'] | 'then'

const quarter = (m: number) => (Math.round(m / 15) * 15) % 1440
/** "15 h · 06:00–21:00"; over midnight "8 h · 22:00–06:00"; in two stretches "6 h · 06:00–09:00, 18:00–21:00". */
function boostWords(periods: Period[]): string | null {
  if (!periods.length) return null
  const minutes = periods.reduce((t, p) => t + (p.off > p.on ? p.off - p.on : p.off + 1440 - p.on), 0)
  return `${Math.round(minutes / 30) / 2} h · ${periods.map(p => `${fmtClock(quarter(p.on))}–${fmtClock(quarter(p.off))}`).join(', ')}`
}
const short = (w: { runs: number[], durationS: number, weekly: boolean }) => `${w.runs.length}×${Math.round(w.durationS / 60)} min${w.weekly ? ' wk' : ''}`

/**
 * The grow protocol on Grow and Water (ADR-0030): the stages as one track
 * from the sowing day with a Then slot at its end, Follow, Hold and Advance,
 * and a panel for the stage picked (the current one to start with) saying
 * what it sets: water, light, feed and checks, each with its source. A later
 * stage says when it starts and what changes; the Then slot says what comes
 * after maintenance, chosen in the row under the panel. Hovering a stage only
 * highlights it and says it in a line.
 */
export function ProtocolCard() {
  const utils = trpc.useUtils()
  const q = trpc.protocol.current.useQuery()
  const library = trpc.schedules.library.list.useQuery()
  const schedules = trpc.schedules.list.useQuery()
  const settings = trpc.settings.get.useQuery()
  // The last action that failed, said once; the next action clears it.
  const [lastError, setLastError] = useState<string | null>(null)
  const failed = (e: { message: string }) => setLastError(e.message)
  const changed = () => {
    void utils.protocol.invalidate()
    void utils.schedules.invalidate()
  }
  const hold = trpc.protocol.hold.useMutation({ onSuccess: changed, onError: failed })
  const release = trpc.protocol.release.useMutation({ onSuccess: changed, onError: failed })
  const advance = trpc.protocol.advance.useMutation({ onSuccess: changed, onError: failed })
  const setThen = trpc.protocol.setThen.useMutation({ onSuccess: changed, onError: failed })
  const activate = trpc.schedules.library.activate.useMutation({ onSuccess: () => {
    changed()
    setApplying(false)
  }, onError: failed })
  const save = trpc.schedules.library.create.useMutation({ onSuccess: changed })
  const follow = trpc.settings.update.useMutation({ onSuccess: () => {
    void utils.settings.invalidate()
    changed()
  }, onError: failed })
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
  // Confirming the stage's watering over cycles changed by hand, with the name to keep those under.
  const [applying, setApplying] = useState(false)
  const [keepAs, setKeepAs] = useState('My cycles')
  /** Clears the last error, then acts. */
  const act = (fn: () => void) => {
    setLastError(null)
    fn()
  }
  const [picked, setPicked] = useState<Picked | null>(null)
  const [hovered, setHovered] = useState<Picked | null>(null)
  const [confirming, setConfirming] = useState(false)
  // The light curves running today on the unit's clock, for the light column and the day strips.
  const zone = settings.data?.timezone ?? systemZone()
  const curves = useMemo(() => (schedules.data ?? []).flatMap(x => asCurve(x) ?? []), [schedules.data])
  const now = new Date()
  const unitNow = localTime(now, zone)
  // Each weekday's light, worked out once per set of curves: its window for the day strips, and its Boost stretches in words.
  const lightByDay = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const specs = runningToday(curves, d).map(c => c.spec)
    return { light: lightWindow(specs), boost: boostWords(lightPeriods(specs, BOOST_LEVEL)) }
  }), [curves])
  const { light, boost } = lightByDay[unitNow.weekday] ?? { light: null, boost: null }
  const today = unitNow.date
  const cycles = (schedules.data ?? []).flatMap(x => asCycle(x) ?? [])

  const r = q.data
  if (!r) return null
  const current = r.stages.find(s => s.id === r.stage) ?? null
  const shown: Picked | null = picked ?? current?.id ?? r.stages[0]?.id ?? null
  const next = nextStage(r)
  // Every protocol ends in its ongoing maintenance stage.
  const last = r.stages.at(-1) as ProtocolStageView
  const own = (library.data ?? []).filter(e => e.kind === 'own')
  const thenEntry = r.then.scheduleId ? (library.data ?? []).find(e => e.id === r.then.scheduleId) ?? null : null
  const noCycle = r.cycleId === null
  // Follow is off, so germination's weekly run keeps its day when the sowing day moves: say so.
  const sowDay = r.sownOn ? (new Date(`${r.sownOn}T00:00:00Z`).getUTCDay() + 6) % 7 : null
  const germinating = followedPreset(cycles)?.id === 'germination' ? cycles[0] : undefined
  const stays = !r.following && germinating && sowDay !== null && germinating.days !== 1 << sowDay ? `Follow is off: your weekly run stays on ${daysLabel(germinating.days)}` : null
  // The stage's watering, to put on the pump when the protocol isn't the one watering.
  const stageWatering = current ? { id: `preset:${current.water.presetId}`, label: `${current.name} watering` } : null
  const useStage = () => stageWatering && act(() => activate.mutate({ id: stageWatering.id }))
  const summary = (id: Picked) => {
    if (id === 'then') return `Then · ${thenLabel(r, thenEntry)}`
    const s = r.stages.find(x => x.id === id)
    if (!s) return ''
    const when = s.state === 'next' && s.startsOn ? `starts ${plainDay(s.startsOn)}` : s.state === 'current' ? 'now' : s.startsOn ? `began ${plainDay(s.startsOn)}` : ''
    return [s.name, `days ${stageDays(s)}`, waterWords(s.water), when].filter(Boolean).join(' · ')
  }

  return (
    <section aria-label="Grow protocol" data-testid="protocol" className="@container flex flex-col rounded-[14px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h2 className="text-base font-semibold">{`${r.protocol.name} protocol`}</h2>
          <p className="text-[13px] text-fg-2" data-testid="protocol-where">{whereWords(r)}</p>
        </div>
        <span className="flex items-center gap-2 text-[13px] text-fg-2" title="As the plants age, move the watering on to each stage's, never back. Cycles you set by hand or one of your schedules are left alone.">
          Follow
          <Toggle on={r.following} size="md" label="Follow the grow cycle" disabled={follow.isPending} onChange={followGrowCycle => act(() => follow.mutate({ followGrowCycle }))} />
        </span>
        {r.hold
          ? <Button icon={Play} disabled={release.isPending} onClick={() => release.mutate()}>Release hold</Button>
          : <Button icon={Pause} disabled={noCycle || !current || hold.isPending} onClick={() => act(() => hold.mutate())}>Hold at this stage</Button>}
        <Button icon={FastForward} disabled={!r.canAdvance || advance.isPending} title={r.canAdvance ? undefined : current?.to === null ? 'Maintenance is the last stage and ongoing' : 'Needs an open cycle'} onClick={() => setConfirming(true)}>Advance now</Button>
      </div>

      {(!r.following || noCycle || r.water !== 'preset' || lastError) && (
        <div className="flex flex-col gap-2 border-b border-line px-5 py-3 text-[13px] text-fg-2" data-testid="protocol-notes">
          {!r.following && (
            <Note text="Follow the grow cycle is off, so the protocol changes no watering; the first-harvest reminder still comes.">
              <Button size="sm" disabled={follow.isPending} onClick={() => act(() => follow.mutate({ followGrowCycle: true }))}>Turn on Follow</Button>
              {/* On a preset that isn't this stage's: put the stage's on. Cycles changed by hand, none or a schedule have their own way below. */}
              {stageWatering && r.water === 'preset' && r.activeScheduleId !== stageWatering.id && <Button size="sm" disabled={activate.isPending} onClick={useStage}>{`Use ${stageWatering.label}`}</Button>}
            </Note>
          )}
          {noCycle && <p>Start a cycle to hold, advance or choose what comes after; the stages count from the earliest pod for now.</p>}
          {r.water === 'none' && stageWatering && (
            <Note text="Not watering yet: there are no pump cycles.">
              <Button size="sm" variant="primary" icon={Droplets} disabled={activate.isPending} onClick={useStage}>{`Start ${stageWatering.label}`}</Button>
            </Note>
          )}
          {r.water === 'edited' && (
            <Note text="The pump cycles were changed by hand, so the protocol leaves them as they are.">
              {stageWatering && (
                <Button
                  size="sm"
                  onClick={() => {
                    setLastError(null)
                    save.reset()
                    setApplying(true)
                  }}
                >
                  {`Use ${stageWatering.label} (replaces your cycles)`}
                </Button>
              )}
            </Note>
          )}
          {r.water === 'schedule' && (
            <Note text={`On your schedule${(library.data ?? []).find(e => e.id === r.activeScheduleId)?.name ? ` ${(library.data ?? []).find(e => e.id === r.activeScheduleId)?.name}` : ''}: the protocol’s watering waits.`}>
              {current && <Button size="sm" disabled={activate.isPending} onClick={useStage}>{`Back to ${current.water.name}`}</Button>}
            </Note>
          )}
          {lastError && <InlineError>{lastError}</InlineError>}
        </div>
      )}

      {/* Sized by the card, never by its cut-short labels, which would otherwise widen the page once they add up. */}
      <div className="flex flex-col gap-2 px-5 py-4 [contain:inline-size]">
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
                {/* How far through the stage today is, up to the line that marks today. */}
                {progress !== null && <span aria-hidden data-testid="today-mark" className="absolute inset-y-0 left-0 border-r-2 border-fg bg-fg/10" style={{ width: `${progress * 100}%` }} />}
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
          {last.startsOn && <span className="font-mono text-[11px] text-fg-3" data-testid="maintenance-on">{`${plainDay(last.startsOn)} · ${last.name.toLowerCase()} ${last.state === 'next' ? 'begins' : 'began'}`}</span>}
          <span className="font-mono text-[11px] text-fg-3">ongoing</span>
        </div>
        <p className="min-h-[16px] truncate font-mono text-[11px] text-fg-2" data-testid="track-hover">{hovered ? summary(hovered) : ''}</p>
      </div>

      {shown === 'then'
        ? <ThenPanel r={r} thenEntry={thenEntry} light={light} boost={boost} />
        : <StagePanel stage={r.stages.find(s => s.id === shown) ?? null} r={r} light={light} boost={boost} />}
      <ThenChoice r={r} own={own} busy={setThen.isPending} onSet={v => act(() => setThen.mutate(v))} />

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
                act(() => advance.mutate())
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
        open={applying && !!stageWatering}
        onClose={() => setApplying(false)}
        title={`Use ${stageWatering?.label ?? ''}?`}
        icon={Droplets}
        footer={(
          <div className="flex gap-2">
            <Button variant="primary" disabled={activate.isPending} onClick={useStage}>{activate.isPending ? 'Replacing…' : `Use ${stageWatering?.label ?? ''}`}</Button>
            <Button onClick={() => setApplying(false)}>Cancel</Button>
          </div>
        )}
      >
        <div className="flex flex-col gap-2.5 text-[13px] text-fg-2" data-testid="apply-stage">
          <p>These go:</p>
          <ul className="flex flex-col gap-1 font-mono text-[12px]">
            {cycles.map(c => <li key={c.id}>{`${fmtClock(c.spec.minute)} · ${c.name}`}</li>)}
          </ul>
          {save.isSuccess
            ? <p data-testid="kept">{`Kept as ${save.data.name} in Your schedules.`}</p>
            : (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    save.mutate({ name: keepAs.trim(), cycles: cycles.map(c => ({ minute: c.spec.minute, durationS: c.spec.durationS, days: c.days })) })
                  }}
                >
                  <TextField label="Keep them first as" mono={false} value={keepAs} onChange={setKeepAs} className="w-48" />
                  <Button type="submit" disabled={save.isPending || !keepAs.trim()}>Save current cycles as a schedule</Button>
                </form>
              )}
          {save.error && <InlineError>{`Couldn't save them: ${save.error.message}`}</InlineError>}
          {lastError && <InlineError>{lastError}</InlineError>}
        </div>
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
  if (r.then.kind === 'remind') return 'ask me first'
  if (r.then.kind === 'schedule') return entry ? `${entry.name} · ${entry.cycles.length}×${Math.round((entry.cycles[0]?.durationS ?? 0) / 60)} min` : 'your schedule'
  return 'keep the last stage'
}

/** A note above the track with what can be done about it. */
function Note({ text, children }: { text: string, children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span>{text}</span>
      {children}
    </div>
  )
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

/** The light at full brightness today, or the preset a stage or one of your schedules sets, saying which. */
function LightColumn({ boost, presetName, source }: { boost: string | null, presetName: string | null, source: 'stage' | 'schedule' }) {
  const caption = presetName
    ? (source === 'stage' ? 'Set by this stage.' : 'From your schedule.')
    : (source === 'stage' ? 'Unchanged: the protocol leaves your light curves as they are.' : 'Unchanged: this schedule leaves your light curves as they are.')
  return (
    <Column title="Light">
      <span className="text-sm font-medium">{presetName ?? boost ?? 'No light at full brightness today'}</span>
      <span className="text-[12px] leading-snug text-fg-2">{caption}</span>
    </Column>
  )
}

/** What a stage sets, with where each comes from; a later stage says when it starts and what changes. */
function StagePanel({ stage: s, r, light, boost }: { stage: ProtocolStageView | null, r: ProtocolReport, light: Light, boost: string | null }) {
  if (!s) return null
  const head = s.state === 'current'
    ? `${stageDayWords(r, s)}${s.to === null ? ' · ongoing' : ''}`
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
        <LightColumn boost={boost} presetName={s.light?.name ?? null} source="stage" />
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
      {/* How to judge any watering, from the same note; Gardyn publishes only germination's. */}
      <ul className="flex list-disc flex-col gap-1 border-t border-line py-3 pl-9 pr-5 text-[12px] leading-snug text-fg-3" data-testid="watering-tips">
        {WATERING_TIPS.map(tip => <li key={tip}>{tip}</li>)}
        <li className="flex list-none flex-wrap gap-x-3">
          <SourceLink href={TIPS_CITATION.url}>{TIPS_CITATION.section}</SourceLink>
          <SourceLink href={GARDYN_WATERING_GUIDE}>Gardyn’s guide</SourceLink>
        </li>
      </ul>
    </div>
  )
}

interface Own { id: string, name: string, cycles: Array<{ minute: number, durationS: number, days: number }>, lightPresetId: string | null }

/** What the Then slot does, for the panel it opens: the schedule's watering and light, or what staying or asking means. */
function ThenPanel({ r, thenEntry, light, boost }: {
  r: ProtocolReport
  thenEntry: Own | null
  light: Light
  boost: string | null
}) {
  // Every protocol ends in its ongoing maintenance stage.
  const last = r.stages.at(-1) as ProtocolStageView
  const name = thenEntry?.name ?? 'your schedule'
  const when = last.startsOn ? `${last.state === 'next' ? 'when maintenance begins, ' : ''}${plainDay(last.startsOn)}` : 'when maintenance begins'
  const stays = `Watering stays on ${last.name}, ${waterWords(last.water)}`
  const sentence = r.then.kind === 'schedule'
    ? (r.then.done ? `Switched to ${name}.` : `Watering switches to ${name} ${when}.`)
    : r.then.kind === 'remind'
      ? (r.then.harvestOn ? `${stays}. On ${plainDay(r.then.harvestOn)}, the crops’ first harvest by the catalog, Needs you asks what comes next.` : `${stays}.`)
      : `${stays}, for as long as the plants grow.`
  const shown = r.then.kind === 'schedule' ? thenEntry : null
  return (
    <div className="flex flex-col border-t border-line" data-testid="then-panel">
      <p className="px-5 pt-3.5 text-[13px] font-medium" data-testid="then-head">{`Then · ${thenLabel(r, thenEntry)}`}</p>
      <p className="px-5 pb-3.5 pt-1 text-[13px] text-fg-2">{sentence}</p>
      {shown && (
        <div className="grid grid-cols-1 gap-px border-t border-line bg-line min-[640px]:grid-cols-2" data-testid="then-schedule">
          <Column title={`Water · ${shown.name}`}>
            <span className="text-sm font-medium">{`${shown.cycles.length} × ${shown.cycles.map(c => `${Math.round(c.durationS / 60)} min`).filter((x, i, a) => a.indexOf(x) === i).join(' / ')}`}</span>
            <WeekdayDots days={shown.cycles.reduce((m, c) => m | c.days, 0)} />
            <DayStrip runs={shown.cycles.map(c => c.minute)} light={light} />
            <span className="font-mono text-[11px] text-fg-2">{shown.cycles.map(c => fmtClock(c.minute)).join(', ')}</span>
          </Column>
          <LightColumn boost={boost} presetName={LIGHT_PRESETS.find(p => p.id === shown.lightPresetId)?.name ?? null} source="schedule" />
        </div>
      )}
    </div>
  )
}

/**
 * What comes after the stages, chosen up front so it's no surprise: keep the
 * last stage (Then `stay`), switch to one of your schedules when maintenance
 * begins or now (`schedule`), or keep the last stage and ask in Needs you at
 * the crops' first harvest (`remind`). Maintenance is ongoing, so it's the
 * day maintenance begins that the row is dated by, not an end.
 */
function ThenChoice({ r, own, busy, onSet }: {
  r: ProtocolReport
  own: Own[]
  busy: boolean
  onSet: (v: { kind: 'stay' | 'schedule' | 'remind', scheduleId?: string, when: 'now' | 'maintenance' }) => void
}) {
  // Every protocol ends in its ongoing maintenance stage.
  const last = r.stages.at(-1) as ProtocolStageView
  const uid = useId()
  const [choice, setChoice] = useState<string | null>(null)
  // The schedule picked, else Then's, else the first: whatever the list holds when it arrives or changes, so Switch always has one.
  const pickedSchedule = own.find(e => e.id === choice) ?? own.find(e => e.id === r.then.scheduleId) ?? own[0] ?? null
  const disabled = r.cycleId === null || busy
  const inMaintenance = r.stage === last.id
  const option = (kind: 'stay' | 'schedule' | 'remind', title: string, sub: ReactNode, extra?: ReactNode, off = false) => (
    <label className={cn('flex min-w-0 cursor-pointer items-start gap-2.5 rounded-[10px] border px-3.5 py-3', r.then.kind === kind ? 'border-pod-ok/60 bg-pod-ok/5' : 'border-line', (disabled || off) && 'cursor-default opacity-60')}>
      {/* Named by its title alone, the rest its description, so the option reads as its choice. */}
      <input
        type="radio"
        name="protocol-then"
        aria-labelledby={`${uid}-${kind}`}
        aria-describedby={sub ? `${uid}-${kind}-sub` : undefined}
        className="mt-0.5 accent-current"
        checked={r.then.kind === kind}
        disabled={disabled || off}
        onChange={() => (kind === 'schedule' ? pickedSchedule && onSet({ kind, scheduleId: pickedSchedule.id, when: 'maintenance' }) : onSet({ kind, when: 'maintenance' }))}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span id={`${uid}-${kind}`} className="text-[13px] font-medium">{title}</span>
        {sub && <span id={`${uid}-${kind}-sub`} className="text-[12px] leading-snug text-fg-2">{sub}</span>}
        {extra}
      </span>
    </label>
  )
  return (
    <div className="flex flex-col border-t border-line" data-testid="then-choice">
      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 px-5 py-4">
        <legend className="mb-2 text-sm font-medium">
          When maintenance begins
          <span className="ml-2 font-mono text-[12px] font-normal text-fg-3" data-testid="then-when">{`${last.startsOn ? `${inMaintenance ? 'began ' : ''}${plainDay(last.startsOn)} · ` : ''}day ${last.from}`}</span>
        </legend>
        <div className="grid grid-cols-1 gap-2.5 @min-[720px]:grid-cols-3">
          {option('stay', 'Keep the last stage', `${last.name} · ${waterWords(last.water)}`)}
          {option(
            'schedule',
            'Switch to my schedule',
            own.length ? (inMaintenance ? 'Maintenance has begun, so this switches now.' : null) : 'Save a schedule of your own first.',
            own.length > 0 && (
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <select
                  aria-label="Schedule to switch to"
                  value={pickedSchedule?.id ?? ''}
                  disabled={disabled}
                  onChange={(e) => {
                    setChoice(e.target.value)
                    if (r.then.kind === 'schedule') onSet({ kind: 'schedule', scheduleId: e.target.value, when: 'maintenance' })
                  }}
                  className="min-w-0 max-w-full flex-1 rounded-[6px] border border-line-2 bg-bg px-2 py-1.5 font-mono text-[12px]"
                >
                  {own.map(e => <option key={e.id} value={e.id}>{`${e.name} · ${e.cycles.length}×${Math.round((e.cycles[0]?.durationS ?? 0) / 60)} min`}</option>)}
                </select>
                {!inMaintenance && pickedSchedule && <Button size="sm" disabled={disabled} onClick={() => onSet({ kind: 'schedule', scheduleId: pickedSchedule.id, when: 'now' })}>Switch now</Button>}
              </span>
            ),
            own.length === 0,
          )}
          {option('remind', 'Ask me first', r.then.harvestOn ? `Keeps the last stage and adds it to Needs you at first harvest, ${plainDay(r.then.harvestOn)}.` : 'No planted crop is in the catalog, so there’s no first-harvest day to ask on.', null, r.then.harvestOn === null)}
        </div>
        {r.then.done && <p className="text-[12px] text-fg-3" data-testid="then-done">{r.then.kind === 'remind' ? 'Asked: it’s in Needs you.' : 'Switched.'}</p>}
      </fieldset>
    </div>
  )
}
