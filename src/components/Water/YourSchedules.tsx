import { Link } from '@tanstack/react-router'
import { Plus, Trash2 } from 'lucide-react'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Badge, Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import type { ProtocolReport } from '@/src/components/Grow/protocolWords'
import { trpc } from '@/src/utils/trpc'
import { fmtDay, type PumpCycle } from './pumpCycles'
import { LIVE, ScheduleEditor, type EditorMode, type Entry } from './ScheduleEditor'
import { RowMenu } from './RowMenu'
import { ScheduleStrip, StripAxis } from './ScheduleStrip'
import { daysWords, runsWords, type Light } from './scheduleWords'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
/**
 * Name, strip, status and buttons across on a wide card; on a narrow one the
 * strip and status go under the name. The rows share the list's columns
 * (subgrid), so every strip, and the hours under them, line up.
 */
const LIST = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 @min-[640px]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto_auto]'
const ROW = 'col-span-full grid grid-cols-subgrid items-center gap-y-2'
/** The track's share for the ongoing stage, as on the protocol card. */
const ONGOING_FLEX = 14

/** "21 Dec" on the unit's calendar. */
const shortDay = (iso: string, zone: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: zone })

/**
 * Your schedules on Water (ADR-0030, design 3b): one row per schedule of
 * yours, the protocol's last stage as a read-only preset beside them (and
 * any other preset that's on), each with its day on the light's band, what
 * it is now, and Use or Edit. Cycles changed by hand head the list as Edited,
 * with Save as schedule. Once watering is on one of yours, the card opens on
 * it: on your schedule, the protocol's stages behind it. New, Edit, Duplicate
 * and Adjust open the editor under the card.
 */
export function YourSchedules({ protocol: r, entries, live, light, limits, zone }: {
  protocol: ProtocolReport | undefined
  entries: readonly Entry[]
  live: readonly PumpCycle[]
  light: Light
  limits: { pumpMaxRunS: number, pumpMaxDuty: number } | null
  zone: string
}) {
  const utils = trpc.useUtils()
  const changed = () => {
    void utils.schedules.invalidate()
    void utils.protocol.invalidate()
  }
  const [lastError, setLastError] = useState<string | null>(null)
  const activate = trpc.schedules.library.activate.useMutation({ onSuccess: changed, onError: e => setLastError(e.message) })
  const remove = trpc.schedules.library.delete.useMutation({ onSuccess: () => {
    changed()
    setDeleting(null)
  }, onError: e => setLastError(e.message) })
  const [editor, setEditor] = useState<EditorMode | null>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const open = (m: EditorMode) => {
    setLastError(null)
    setEditor(m)
  }
  const use = (id: string) => {
    setLastError(null)
    activate.mutate({ id })
  }

  const last = r?.stages.at(-1)
  const current = r?.stages.find(s => s.id === r.stage) ?? null
  const finalPreset = last ? `preset:${last.water.presetId}` : null
  // Yours, then the protocol's last stage and whichever preset is on: going back to what the protocol did is one click.
  const shown = entries.filter(e => e.kind === 'own' || e.id === finalPreset || e.active)
  const active = entries.find(e => e.active) ?? null
  // Known only once the library says which entry, if any, is on.
  const edited = live.length > 0 && !active && entries.length > 0
  const onYours = active?.kind === 'own' ? active : null
  // The protocol is watering and maintenance hasn't begun, with a cycle to queue a Then on.
  const duringProtocol = !!r && r.cycleId !== null && r.following && r.water === 'preset' && current !== null && current !== last

  const row = (key: string, name: ReactNode, summary: string, strip: ReactNode, status: string, actions: ReactNode, testid?: string) => (
    <div key={key} className={cn(ROW, 'border-t border-line py-3.5')} data-testid={testid ?? 'schedule-row'}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[15px] font-medium">{name}</span>
        <span className="font-mono text-[12px] text-fg-2">{summary}</span>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 @min-[640px]:col-span-1 @min-[640px]:row-start-auto">{strip}</div>
      <span className="col-span-2 row-start-3 font-mono text-[12px] text-fg-3 @min-[640px]:col-span-1 @min-[640px]:row-start-auto" data-testid="schedule-status">{status}</span>
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 @min-[640px]:col-start-auto @min-[640px]:row-start-auto">{actions}</div>
    </div>
  )

  return (
    <>
      <section id="pump-cycles" aria-label="Your schedules" data-testid="your-schedules" className="@container flex scroll-mt-6 flex-col rounded-[14px] border border-line bg-surface [contain:inline-size]">
        {onYours && r && (
          <OnYourSchedule r={r} entry={onYours} zone={zone} busy={activate.isPending} onBack={current ? () => use(`preset:${current.water.presetId}`) : null} />
        )}
        <div className="flex flex-col px-5 pb-2 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5">
            <h2 className={EYEBROW}>Your schedules</h2>
            <Button icon={Plus} onClick={() => open({ kind: 'new', from: finalPreset ?? entries[0]?.id ?? LIVE })}>New schedule</Button>
          </div>
          <div className={LIST}>
            {edited && row(
              'edited',
              <>
                Your cycles
                <Badge variant="paused">EDITED</Badge>
              </>,
              `${runsWords(live.map(c => ({ ...c.spec, days: c.days })))} · ${daysWords(live.map(c => ({ ...c.spec, days: c.days })))}`,
              <ScheduleStrip runs={live.map(c => c.spec)} light={light} tone="active" />,
              'changed by hand',
              <>
                <Button size="sm" onClick={() => open({ kind: 'new', from: LIVE })}>Save as schedule</Button>
                <RowMenu label="More for Your cycles" items={[{ label: 'Adjust the cycles', onSelect: () => open({ kind: 'live' }) }]} />
              </>,
              'schedule-edited',
            )}
            {shown.map((e) => {
              const status = e.kind === 'preset'
                ? 'preset · read-only'
                : e.active
                  ? (e.lastUsedAt ? `since ${shortDay(e.lastUsedAt, zone)}` : 'in use')
                  : e.lastUsedAt ? `last used ${shortDay(e.lastUsedAt, zone)}` : 'not used yet'
              const items = [
                ...(e.active ? [{ label: 'Adjust the cycles', onSelect: () => open({ kind: 'live' }) }] : []),
                ...(e.kind === 'own' && !e.active ? [{ label: 'Edit', onSelect: () => open({ kind: 'edit', id: e.id }) }] : []),
                { label: 'Duplicate', onSelect: () => open({ kind: 'new', from: e.id, name: `${e.name} copy` }) },
                ...(e.kind === 'own' ? [{ label: 'Delete', danger: true, onSelect: () => setDeleting(e) }] : []),
              ]
              return row(
                e.id,
                <>
                  <span className="min-w-0 break-words">{e.name}</span>
                  {e.active && <Badge variant="active" />}
                </>,
                `${runsWords(e.cycles)} · ${e.kind === 'preset' ? 'from the protocol' : daysWords(e.cycles)}`,
                <ScheduleStrip runs={e.cycles} light={light} tone={e.active ? 'active' : 'muted'} />,
                status,
                <>
                  {e.active
                    ? (e.kind === 'own' && <Button size="sm" onClick={() => open({ kind: 'edit', id: e.id })}>Edit</Button>)
                    : <Button size="sm" disabled={activate.isPending} onClick={() => use(e.id)}>Use</Button>}
                  <RowMenu label={`More for ${e.name}`} items={items} />
                </>,
              )
            })}
            {(shown.length > 0 || edited) && (
              <div className={ROW}>
                <StripAxis light={light} className="col-span-2 @min-[640px]:col-span-1 @min-[640px]:col-start-2" />
              </div>
            )}
          </div>
          {lastError && <InlineError className="pb-3">{lastError}</InlineError>}
        </div>
      </section>

      {editor && (
        <ScheduleEditor
          // A new mode is a new draft.
          key={JSON.stringify(editor)}
          mode={editor}
          entries={entries}
          live={live}
          light={light}
          limits={limits}
          duringProtocol={duringProtocol}
          onClose={() => setEditor(null)}
        />
      )}

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        icon={Trash2}
        footer={(
          <div className="flex gap-2">
            <Button variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate({ id: deleting.id })}>Delete</Button>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
          </div>
        )}
      >
        <p className="text-[13px] text-fg-2">
          {deleting?.active
            ? 'Its cycles stay on the pump until you use another schedule.'
            : r?.then.kind === 'schedule' && r.then.scheduleId === deleting?.id
              ? 'It’s what comes after the stages, so that goes back to keeping the last stage.'
              : 'It goes from Your schedules; the pump cycles don’t change.'}
        </p>
      </Modal>
    </>
  )
}

/** The card's head once watering is on one of yours (design 3b): which, since when, the stages behind it, and the ways back. */
function OnYourSchedule({ r, entry, zone, busy, onBack }: { r: ProtocolReport, entry: Entry, zone: string, busy: boolean, onBack: (() => void) | null }) {
  const since = entry.lastUsedAt ? fmtDay(new Date(entry.lastUsedAt), zone) : null
  return (
    <div className="flex flex-col border-b border-line" data-testid="on-your-schedule">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-[min(240px,100%)] flex-1 flex-col gap-1">
          <h2 className="text-base font-semibold">{`On your schedule · ${entry.name}`}</h2>
          <p className="text-[13px] text-fg-2">{[`Off the ${r.protocol.name} protocol${since ? ` since ${since}` : ''}`, r.daysSinceSowing === null ? null : `now day ${r.daysSinceSowing}`].filter(Boolean).join(' · ')}</p>
        </div>
        {onBack && <Button size="sm" disabled={busy} title="Use the current stage’s watering again: the protocol moves it on from there" onClick={onBack}>Back to the protocol</Button>}
        <Link to="/grow" className="text-[13px] text-pod-ok underline underline-offset-2">Start a new grow</Link>
      </div>
      <div className="flex flex-col gap-2 px-5 py-4">
        <div className="flex h-1.5 gap-1" aria-hidden>
          {r.stages.map(s => <span key={s.id} className="rounded-full bg-fg-3/40 [flex:var(--len)_1_0%]" style={{ '--len': s.to === null ? ONGOING_FLEX : s.to - s.from + 1 } as CSSProperties} />)}
          <span className="rounded-full bg-pod-ok [flex:10_1_0%]" />
        </div>
        <div className="flex flex-wrap justify-between gap-x-3 font-mono text-[11px] text-fg-3">
          <span>{r.stages.map(s => s.name).join(' → ')}</span>
          <span className="text-pod-ok">your schedule</span>
        </div>
      </div>
    </div>
  )
}
