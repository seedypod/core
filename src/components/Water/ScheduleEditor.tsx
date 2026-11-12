import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button, GhostIcon, InlineError } from '@/src/components/ds/core'
import { DayPicker, TextField } from '@/src/components/ds/forms'
import { fmtClock } from '@/src/components/charts/format'
import { SourceLink } from '@/src/components/Water/DayStrip'
import { daysToList, listToDays } from '@/src/lib/days'
import { hhmm, TIPS_CITATION } from '@/src/scheduler/pumpPlan'
import { trpc } from '@/src/utils/trpc'
import { fmtMinutes, type PumpCycle } from './pumpCycles'
import { ScheduleStrip } from './ScheduleStrip'
import { amount, comparedWith, outOfLight, overLimit, runsWords, sharedDays, type Cycle, type Light } from './scheduleWords'

/** The editor's run lengths, in seconds: the presets' among them, so a 6-minute preset cycle reads as itself. */
const CYCLE_DURATIONS = [60, 180, 300, 360, 480, 600, 900]
const MAX_CYCLES = 12
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const LABEL = 'text-xs text-fg-2'
/** Where the editor's cycles start from when it's the live ones, not a library entry. */
export const LIVE = 'live'

/** The editor's lengths, with a cycle's own if it's none of them, so editing never changes it unasked; none past the pump's limit but that. */
export function editorLengths(current: number, maxRunS = Number.POSITIVE_INFINITY): number[] {
  const usual = CYCLE_DURATIONS.filter(d => d <= maxRunS)
  return usual.includes(current) ? usual : [...usual, current].sort((a, b) => a - b)
}

export interface Entry { id: string, name: string, kind: 'own' | 'preset', cycles: Cycle[], lightPresetId: string | null, lastUsedAt: string | null, active: boolean, readOnly: boolean }

/** A new schedule (from an entry or the live cycles), one of yours to change, or the pump cycles themselves, changed by hand. */
export type EditorMode = { kind: 'new', from: string, name?: string } | { kind: 'edit', id: string } | { kind: 'live' }

/** A cycle being edited; one from the live cycles keeps its id, name, level and on/off. */
interface Draft extends Cycle { key: number, id?: string, name?: string, level?: number, enabled?: boolean }

const fromLive = (live: readonly PumpCycle[]): Draft[] => live.map((c, i) => ({ key: i, minute: c.spec.minute, durationS: c.spec.durationS, days: c.days, id: c.id, name: c.name, level: c.spec.level, enabled: c.enabled }))
const fromCycles = (cycles: readonly Cycle[]): Draft[] => cycles.map((c, i) => ({ key: i, minute: c.minute, durationS: c.durationS, days: c.days }))

/**
 * The schedule editor (design 3c): name, where it starts from, its cycles
 * (a time and a length each) and days on the left; on the right, what it adds
 * up to against where it started, its day on the light's band, any cycle
 * outside the light with a whole hour to move it to, and the pump's limit.
 * Saving keeps it in Your schedules; the main button uses it after the
 * protocol while one is watering, else now. On the live cycles, it changes
 * them in place, which reads as Edited until they're saved as a schedule.
 */
export function ScheduleEditor({ mode, entries, live, light, limits, duringProtocol, onClose }: {
  mode: EditorMode
  entries: readonly Entry[]
  live: readonly PumpCycle[]
  light: Light
  limits: { pumpMaxRunS: number, pumpMaxDuty: number } | null
  /** The protocol is watering and maintenance hasn't begun: "use" queues it for when it does. */
  duringProtocol: boolean
  onClose: () => void
}) {
  const utils = trpc.useUtils()
  const create = trpc.schedules.library.create.useMutation()
  const update = trpc.schedules.library.update.useMutation()
  const activate = trpc.schedules.library.activate.useMutation()
  const setThen = trpc.protocol.setThen.useMutation()
  const upsert = trpc.schedules.upsert.useMutation()
  const remove = trpc.schedules.remove.useMutation()
  const editing = mode.kind === 'edit' ? entries.find(e => e.id === mode.id) ?? null : null
  const source = (id: string) => (id === LIVE ? { name: 'The pump cycles now', cycles: fromLive(live) } : entries.find(e => e.id === id) ?? null)
  const [from, setFrom] = useState(mode.kind === 'new' ? mode.from : mode.kind === 'edit' ? mode.id : LIVE)
  const [name, setName] = useState(mode.kind === 'new' ? mode.name ?? '' : editing?.name ?? '')
  const [cycles, setCycles] = useState<Draft[]>(() => {
    const s = source(from)
    return s ? ('id' in s ? fromCycles(s.cycles) : s.cycles) : []
  })
  // One mask for every cycle, or null while the cycles keep days of their own.
  const [days, setDays] = useState<number | null>(() => sharedDays(cycles) ?? (cycles.length ? null : 127))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nextKey = useRef(cycles.length)
  const card = useRef<HTMLElement>(null)
  useEffect(() => {
    card.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [])

  const out: Draft[] = cycles.map(c => ({ ...c, days: days ?? c.days }))
  const sorted = [...out].sort((a, b) => a.minute - b.minute)
  const base = source(from)
  const dark = outOfLight(out, light)
  const over = limits ? overLimit(out, limits.pumpMaxRunS) : []
  const twice = sorted.find((c, i) => i > 0 && sorted[i - 1]?.minute === c.minute)
  const problem = !cycles.length
    ? 'Add a cycle.'
    : twice
      ? `Two cycles start at ${hhmm(twice.minute)}.`
      : (days ?? 1) === 0
          ? 'Pick at least one day.'
          : null
  const named = name.trim().length > 0
  const total = amount(out)
  const unionDays = cycles.reduce((m, c) => m | c.days, 0)

  const change = (key: number, patch: Partial<Cycle>) => setCycles(cs => cs.map(c => (c.key === key ? { ...c, ...patch } : c)))
  const add = () => {
    const taken = new Set(cycles.map(c => c.minute))
    const lastAt = sorted.at(-1)?.minute
    const start = lastAt === undefined ? (light ? Math.ceil(light.on / 60) * 60 + 60 : 480) : lastAt + 240
    const candidates = [start, ...Array.from({ length: 24 }, (_, i) => (Math.floor(start / 60) * 60 + (i + 1) * 60) % 1440)]
    const inLight = (m: number) => !light || (m >= light.on && m + 5 <= light.off)
    const minute = candidates.find(m => m < 1440 && !taken.has(m) && inLight(m)) ?? candidates.find(m => m < 1440 && !taken.has(m)) ?? 0
    setCycles(cs => [...cs, { key: nextKey.current++, minute, durationS: cycles.at(-1)?.durationS ?? 300, days: days ?? 127 }])
  }
  const pickFrom = (id: string) => {
    setFrom(id)
    const s = source(id)
    if (!s) return
    const next = 'id' in s ? fromCycles(s.cycles) : s.cycles
    nextKey.current = next.length
    setCycles(next)
    setDays(sharedDays(next))
  }

  /** Runs the steps in order, saying why if one fails; reads the schedules and the protocol again once done. */
  const run = async (steps: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await steps()
      void utils.schedules.invalidate()
      void utils.protocol.invalidate()
      onClose()
    }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    finally {
      setBusy(false)
    }
  }
  const saved = sorted.map(c => ({ minute: c.minute, durationS: c.durationS, days: c.days }))
  const save = (then?: 'use' | 'after') => run(async () => {
    const entry = editing
      ? await update.mutateAsync({ id: editing.id, name: name.trim(), cycles: saved })
      : await create.mutateAsync({ name: name.trim(), cycles: saved })
    if (then === 'use') await activate.mutateAsync({ id: entry.id })
    if (then === 'after') await setThen.mutateAsync({ kind: 'schedule', scheduleId: entry.id, when: 'maintenance' })
  })
  /** The live cycles changed in place: each kept under its id, new ones added, the ones taken out removed. */
  const apply = () => run(async () => {
    const ids = new Set<string>()
    for (const c of sorted) {
      let id = c.id ?? `pump-${hhmm(c.minute).replace(':', '')}`
      if (ids.has(id) || (!c.id && live.some(l => l.id === id))) id = `${id}-${c.key}`
      ids.add(id)
      await upsert.mutateAsync({ id, kind: 'pump', name: c.name ?? `Watering · ${fmtMinutes(c.durationS)} (${hhmm(c.minute)})`, enabled: c.enabled ?? true, days: c.days, spec: { minute: c.minute, durationS: c.durationS, ...(c.level ? { level: c.level } : {}) } })
    }
    for (const l of live) if (!ids.has(l.id)) await remove.mutateAsync({ id: l.id })
  })

  const title = mode.kind === 'edit' ? `Edit ${editing?.name ?? 'schedule'}` : mode.kind === 'live' ? 'Adjust the pump cycles' : 'New schedule'
  const note = mode.kind === 'live'
    ? 'Changes the pump cycles now, outside Your schedules: they show as Edited, and the protocol leaves them as they are.'
    : editing?.active
      ? 'It’s in use: the pump cycles change with it.'
      : duringProtocol ? 'Saved to Your schedules. Using it now ends the protocol early.' : 'Saved to Your schedules.'
  const blocked = busy || problem !== null

  return (
    <section ref={card} aria-label={title} data-testid="schedule-editor" className="@container flex scroll-mt-6 flex-col rounded-[14px] border border-line bg-surface">
      <h2 className="border-b border-line px-5 py-3.5 text-[15px] font-medium">{title}</h2>
      <div className="grid grid-cols-1 @min-[760px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-5 border-line px-5 py-5 @min-[760px]:border-r">
          <TextField label="Name" mono={false} value={name} placeholder="Summer" maxLength={60} onChange={setName} />
          {mode.kind === 'new' && (
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className={LABEL}>Start from</span>
              <select aria-label="Start from" value={from} onChange={e => pickFrom(e.target.value)} className="min-w-0 rounded-ctl border border-line-2 bg-field px-3 py-[9px] text-sm text-fg outline-none focus:border-fg-3">
                {live.length > 0 && <option value={LIVE}>{`The pump cycles now · ${runsWords(fromLive(live))}`}</option>}
                {entries.map(e => <option key={e.id} value={e.id}>{`${e.name} · ${runsWords(e.cycles)}`}</option>)}
              </select>
            </label>
          )}
          <div className="flex flex-col gap-2" role="group" aria-label="Cycles">
            <span className={LABEL}>Cycles</span>
            {cycles.map((c, i) => {
              const warn = dark.some(d => d.minute === c.minute) || over.includes(out[i] as Draft)
              return (
                <div key={c.key} className="flex items-center gap-2">
                  <input
                    type="time"
                    aria-label={`Cycle ${i + 1} time`}
                    className={cn('lp-btn w-[7.5rem] font-mono', warn && 'border-pod-ready')}
                    value={fmtClock(c.minute)}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(':').map(Number)
                      if (e.target.value) change(c.key, { minute: (h ?? 0) * 60 + (m ?? 0) })
                    }}
                  />
                  <select
                    aria-label={`Cycle ${i + 1} length`}
                    value={c.durationS}
                    onChange={e => change(c.key, { durationS: Number(e.target.value) })}
                    className="rounded-ctl border border-line-2 bg-field px-2.5 py-[7px] font-mono text-[13px] text-fg outline-none focus:border-fg-3"
                  >
                    {editorLengths(c.durationS, limits?.pumpMaxRunS).map(d => <option key={d} value={d}>{fmtMinutes(d)}</option>)}
                  </select>
                  <GhostIcon icon={X} label={`Remove the ${fmtClock(c.minute)} cycle`} className="ml-auto text-fg-3" onClick={() => setCycles(cs => cs.filter(x => x.key !== c.key))} />
                </div>
              )
            })}
            <Button icon={Plus} className="w-fit border-dashed" disabled={cycles.length >= MAX_CYCLES} onClick={add}>Add cycle</Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Days</span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <DayPicker className="w-full max-w-[20rem]" labels={DAY_NAMES} value={daysToList(days ?? unionDays)} onChange={v => setDays(listToDays(v))} />
              <span className="font-mono text-[12px] text-fg-3" data-testid="editor-days">{days === null ? 'as each cycle has it' : days === 127 ? 'every day' : ''}</span>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4 border-t border-line px-5 py-5 @min-[760px]:border-t-0" data-testid="editor-preview">
          <p className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="font-mono text-[40px] font-medium leading-none">{`${total.minutes} min`}</span>
            <span className="text-[14px] text-fg-2">{cycles.length ? `${total.per} · ${runsWords(out)}` : total.per}</span>
          </p>
          {base && cycles.length > 0 && <p className="text-[13px] text-fg-2" data-testid="editor-compare">{comparedWith(base.name, base.cycles, out)}</p>}
          <div className="flex flex-col gap-1">
            <ScheduleStrip runs={out} light={light} label tone="active" warn={dark.map(d => d.minute)} />
            <div className="flex justify-between font-mono text-[10px] text-fg-3" aria-hidden>
              {['00', '06', '12', '18', '24'].map(h => <span key={h}>{h}</span>)}
            </div>
          </div>
          {!light && <p className="text-[12px] text-fg-3">No light curve runs today, so there’s no light to check the cycles against.</p>}
          {dark.map(d => (
            <div key={d.minute} className="flex gap-2.5 rounded-[10px] border border-pod-ready/50 px-3.5 py-3" data-testid="editor-dark">
              <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-pod-ready" />
              <div className="flex min-w-0 flex-col gap-1 text-[13px]">
                <span className="font-medium">{d.why}</span>
                <span className="text-fg-2">
                  {'Space the cycles across the light hours, so pods don’t dry out under the LEDs. '}
                  <SourceLink href={TIPS_CITATION.url} className="text-fg-3">{TIPS_CITATION.section}</SourceLink>
                </span>
                {d.moveTo !== null && (
                  <button
                    type="button"
                    className="w-fit cursor-pointer border-0 bg-transparent p-0 text-pod-ok underline underline-offset-2"
                    onClick={() => setCycles(cs => cs.map(c => (c.minute === d.minute ? { ...c, minute: d.moveTo as number } : c)))}
                  >
                    {`Move to ${hhmm(d.moveTo)}`}
                  </button>
                )}
              </div>
            </div>
          ))}
          {limits && (
            <p className="border-t border-line pt-3 font-mono text-[12px] text-fg-3" data-testid="editor-limit">
              {'pump limit '}
              <span className="text-fg">{`${fmtMinutes(limits.pumpMaxRunS)}/run · ${limits.pumpMaxDuty}% duty`}</span>
              {over.length ? <span className="text-pod-ready">{` · ${over.map(c => fmtMinutes(c.durationS)).join(', ')} is over: it stops at ${fmtMinutes(limits.pumpMaxRunS)}`}</span> : <span className="text-pod-ok"> ✓</span>}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-5 py-3.5">
        <span className="min-w-0 flex-1 basis-[16rem] text-[12px] text-fg-2" data-testid="editor-note">{problem ?? note}</span>
        {error && <InlineError className="basis-full">{`Couldn’t save it: ${error}`}</InlineError>}
        <Button className="border-0" disabled={busy} onClick={onClose}>Cancel</Button>
        {mode.kind === 'live'
          ? (
              <>
                <Button disabled={blocked || !named} title={named ? undefined : 'Name it first'} onClick={() => void save('use')}>Save as schedule</Button>
                <Button variant="primary" disabled={blocked} onClick={() => void apply()}>Apply</Button>
              </>
            )
          : editing?.active
            ? <Button variant="primary" disabled={blocked || !named} onClick={() => void save()}>Save</Button>
            : (
                <>
                  <Button disabled={blocked || !named} onClick={() => void save()}>Save</Button>
                  <Button variant="primary" disabled={blocked || !named} onClick={() => void save(duringProtocol ? 'after' : 'use')}>{duringProtocol ? 'Save & use after protocol' : 'Save & use now'}</Button>
                </>
              )}
      </div>
    </section>
  )
}
