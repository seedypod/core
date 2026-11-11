import { ChevronLeft, ChevronRight, Eraser, Tag } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button, GhostIcon, InlineError } from '@/src/components/ds/core'
import { Pill, SegmentedControl } from '@/src/components/ds/forms'
import { fmtStamp } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { POD_LABELS, type PodLabelValue } from '@/src/store/types'
import { apiBase, trpc } from '@/src/utils/trpc'
import type { PodRegions } from '@/src/vision/regions'

type Camera = 'upper' | 'lower'
type Shown = Camera | 'both'
type Tab = 'tag' | 'all'
/** What a tap does: set a label, or take it off. */
type Brush = PodLabelValue | 'clear'
type Frame = inferRouterOutputs<AppRouter>['camera']['list'][number]
type Entry = inferRouterOutputs<AppRouter>['vision']['labelList']['labels'][number]

/** Each label's colour, from the pod and growth-stage tokens. */
export const LABEL_COLOR: Record<PodLabelValue, string> = {
  empty: 'var(--pod-empty)',
  seeded: 'var(--pod-seeded)',
  sprouted: 'var(--growth-sprout)',
  growing: 'var(--pod-ok)',
  ready: 'var(--pod-ready)',
  unhealthy: 'var(--pod-attention)',
}
/** What each label means, on its chip's tooltip. */
export const LABEL_MEANING: Record<PodLabelValue, string> = {
  empty: 'Capped, no yCube',
  seeded: 'A yCube in, nothing visible yet',
  sprouted: 'First leaves showing',
  growing: 'Leafy, not ready yet',
  ready: 'Ready to harvest',
  unhealthy: 'Yellowing, wilting or damaged',
}
const name = (l: PodLabelValue) => l[0]?.toUpperCase() + l.slice(1)
const SHOWN = [{ value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }, { value: 'both', label: 'Both' }] as const
const TABS = [{ value: 'tag', label: 'Tag photos' }, { value: 'all', label: 'All labels' }] as const
/** How far back the tagger can step, per camera. */
export const HISTORY = 48
/** Labels per page of All labels. */
export const PAGE = 60
/** An upper and a lower still this close together are one round of captures. */
const ROUND_MS = 5 * 60_000
const at = (n: number) => `${n * 100}%`
const srcOf = (path: string, url: string) => (path.startsWith('data:') ? path : `${apiBase()}${url}`)

/** One round of captures: its newest still's time, and each camera's still in it, if it took one. */
export interface Round { ts: string, upper?: Frame, lower?: Frame }

/**
 * The rounds the Both view steps through, newest first. A round holds at most
 * one still per camera, within ROUND_MS of its newest; a camera that took
 * none in that window has no still in the round, rather than an older one.
 */
export function rounds(frames: Frame[]): Round[] {
  const out: Round[] = []
  for (const f of [...frames].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))) {
    const round = out.at(-1)
    if (round && !round[f.camera] && Date.parse(round.ts) - Date.parse(f.ts) <= ROUND_MS) round[f.camera] = f
    else out.push({ ts: f.ts, [f.camera]: f })
  }
  return out
}

function Dot({ label }: { label: PodLabelValue }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: LABEL_COLOR[label] }} />
}

/** One chip per label, and Clear when `clear` is set. */
function LabelChips({ value, onPick, clear, ariaLabel }: { value: Brush | null, onPick: (b: Brush) => void, clear?: boolean, ariaLabel: string }) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {POD_LABELS.map(l => (
        <Pill key={l} selected={value === l} title={LABEL_MEANING[l]} className="flex items-center gap-1.5 px-2.5 py-1 text-xs" onClick={() => onPick(l)}>
          <Dot label={l} />
          {name(l)}
        </Pill>
      ))}
      {clear && (
        <Pill selected={value === 'clear'} title="Taps take a pod's label off" className="flex items-center gap-1.5 px-2.5 py-1 text-xs" onClick={() => onPick('clear')}>
          <Eraser size={12} aria-hidden className="text-fg-3" />
          Clear
        </Pill>
      )}
    </div>
  )
}

/** One camera's still with a tappable box per pod. */
function Photo({ camera, frame, regions, labelOf, onTap, compact, empty }: {
  camera: Camera
  frame: Frame | undefined
  regions: PodRegions
  labelOf: (slot: number) => PodLabelValue | null
  onTap: (slot: number) => void
  /** Side by side, where the label's word won't fit a box. */
  compact?: boolean
  /** What shows without a still. */
  empty: string
}) {
  const [ratio, setRatio] = useState(4 / 3)
  const slots = Object.keys(regions).map(Number)
  return (
    <div className="relative overflow-hidden rounded-[10px] bg-code" style={{ aspectRatio: ratio }}>
      {frame
        ? (
            <>
              <img
                src={srcOf(frame.path, frame.url)}
                alt={`${camera} camera at ${frame.ts}`}
                className="absolute inset-0 size-full"
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                  if (w > 0 && h > 0) setRatio(w / h)
                }}
              />
              <div className="absolute inset-0" data-testid={`label-pods-${camera}`}>
                {slots.map((s) => {
                  const r = regions[s]
                  if (!r) return null
                  const l = labelOf(s)
                  return (
                    <button
                      key={s}
                      type="button"
                      data-slot={s}
                      aria-pressed={l !== null}
                      aria-label={`Pod ${s}: ${l ?? 'not labelled'}`}
                      className={cn('absolute cursor-pointer rounded-[3px] border-[1.5px] p-0 outline-none focus-visible:border-fg', l ? 'border-solid' : 'border-dashed border-fg-2/70 bg-transparent hover:bg-fg/10')}
                      style={{ left: at(r.x), top: at(r.y), width: at(r.w), height: at(r.h), ...(l ? { borderColor: LABEL_COLOR[l], background: `color-mix(in oklab, ${LABEL_COLOR[l]} 18%, transparent)` } : null) }}
                      onClick={() => onTap(s)}
                    >
                      <span
                        className={cn('absolute left-0 top-0 whitespace-nowrap rounded-br-[4px] px-1 font-mono text-[10px] leading-[14px]', l ? 'text-inverse' : 'bg-code/80 text-fg-2')}
                        style={l ? { background: LABEL_COLOR[l] } : undefined}
                      >
                        {s}
                        {/* The fill says which label on a phone, where the word won't fit the box. */}
                        {l && !compact && <span className="hidden sm:inline">{` · ${l}`}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )
        : <div className="flex size-full items-center justify-center p-4 text-center text-[13px] text-fg-3">{empty}</div>}
    </div>
  )
}

/**
 * Tag what each pod shows in a capture (#184), the ground truth a pod
 * classifier is trained on (ADR-0019). Pick a label, then tap pods: one tap
 * sets it, tapping a pod that already has it (or tapping with Clear) clears
 * it, and a pod can be retagged at any time. Both shows the two cameras'
 * stills from one round together. All labels lists every tagged pod as its
 * crop, to check, change or remove. Labels go into the dataset export with
 * each pod's crop.
 */
export function LabelPods({ boxes }: { boxes: (camera: Camera) => PodRegions }) {
  const utils = trpc.useUtils()
  const [tab, setTab] = useState<Tab>('tag')
  const [shown, setShown] = useState<Shown>('upper')
  const [index, setIndex] = useState(0)
  // A capture opened from All labels, shown until the grower steps away from it.
  const [opened, setOpened] = useState<string | null>(null)
  const [brush, setBrush] = useState<Brush>('growing')
  // Taps show at once; the server's answer replaces them when it comes back.
  const [local, setLocal] = useState<Record<string, PodLabelValue | null>>({})
  const upperList = trpc.camera.list.useQuery({ camera: 'upper', limit: HISTORY }, { enabled: shown !== 'lower' })
  const lowerList = trpc.camera.list.useQuery({ camera: 'lower', limit: HISTORY }, { enabled: shown !== 'upper' })
  const lists: Record<Camera, Frame[]> = { upper: upperList.data ?? [], lower: lowerList.data ?? [] }
  const single = shown === 'both' ? null : shown

  const steps: Round[] = single ? lists[single].map(f => ({ ts: f.ts, [single]: f })) : rounds([...lists.upper, ...lists.lower])
  const found = opened && single ? lists[single].findIndex(f => f.id === opened) : -1
  // A capture opened from All labels that is older than the tagger's history is fetched on its own.
  const beyond = !!opened && !!single && found < 0 && (single === 'upper' ? upperList.data : lowerList.data) !== undefined
  const fetched = trpc.camera.get.useQuery({ id: opened ?? '' }, { enabled: beyond, retry: false })
  const pinned = beyond ? fetched.data : undefined
  const step = found >= 0 ? found : Math.min(index, Math.max(0, steps.length - 1))
  const round: Round | undefined = pinned && single ? { ts: pinned.ts, [single]: pinned } : steps[step]
  const moment = round?.ts
  const frames: Record<Camera, Frame | undefined> = { upper: round?.upper, lower: round?.lower }
  const saved = {
    upper: trpc.vision.labels.useQuery({ captureId: frames.upper?.id ?? '' }, { enabled: !!frames.upper }),
    lower: trpc.vision.labels.useQuery({ captureId: frames.lower?.id ?? '' }, { enabled: !!frames.lower }),
  }
  const stats = trpc.vision.labelStats.useQuery()
  const set = trpc.vision.setLabel.useMutation({
    onSuccess: () => {
      void utils.vision.invalidate()
    },
    onError: (_e, v) => setLocal(m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== `${v.captureId}#${v.slot}`))),
  })

  const labelOf = (camera: Camera, slot: number): PodLabelValue | null => {
    const frame = frames[camera]
    const k = `${frame?.id}#${slot}`
    if (k in local) return local[k] ?? null
    return saved[camera].data?.find(l => l.slot === slot)?.label ?? null
  }
  const tap = (camera: Camera, slot: number) => {
    const frame = frames[camera]
    if (!frame) return
    const was = labelOf(camera, slot)
    const next = brush === 'clear' || was === brush ? null : brush
    if (next === was) return
    setLocal(m => ({ ...m, [`${frame.id}#${slot}`]: next }))
    set.mutate({ captureId: frame.id, slot, label: next })
  }
  const go = (i: number) => {
    setIndex(i)
    setOpened(null)
    setLocal({})
  }
  const open = (l: Entry) => {
    setTab('tag')
    setShown(l.camera)
    setOpened(l.captureId)
    setIndex(0)
    setLocal({})
  }
  const cameras: Camera[] = single ? [single] : ['upper', 'lower']
  const pictured = cameras.filter(c => frames[c])
  const slots = pictured.flatMap(c => Object.keys(boxes(c)).map(Number).map(s => [c, s] as const))
  const done = slots.filter(([c, s]) => labelOf(c, s) !== null).length
  const counts = stats.data?.counts
  const total = stats.data?.pods ?? 0
  // A capture opened from All labels that is gone: say so rather than show another one silently.
  const missed = beyond && !!fetched.error

  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="mr-auto flex min-w-0 flex-col gap-[3px]">
          <span className="flex items-center gap-1.5 text-[15px] font-medium">
            <Tag size={15} className="text-fg-3" />
            Label pods
          </span>
          <span className="text-xs text-fg-3">Tag what each pod shows: Empty is capped, Seeded has a yCube with nothing up yet. Labels go in the dataset export, to train a pod model.</span>
        </div>
        <SegmentedControl ariaLabel="Label view" size="sm" options={TABS} value={tab} onChange={setTab} />
        {tab === 'tag' && (
          <SegmentedControl
            ariaLabel="Label camera"
            size="sm"
            options={SHOWN}
            value={shown}
            onChange={(c) => {
              setShown(c)
              go(0)
            }}
          />
        )}
      </div>

      {tab === 'all'
        ? <AllLabels boxes={boxes} counts={counts} total={total} onOpen={open} />
        : (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[11px] text-fg-3" aria-label="Label counts">
                {POD_LABELS.map(l => (
                  <span key={l} className="flex items-center gap-1.5" data-testid={`count-${l}`}>
                    <Dot label={l} />
                    {`${name(l)} ${counts?.[l] ?? 0}`}
                  </span>
                ))}
                <span className="ml-auto">{`${total} pod${total === 1 ? '' : 's'} labelled`}</span>
              </div>

              <div className="flex flex-col gap-1.5">
                <LabelChips ariaLabel="Label to apply" value={brush} onPick={setBrush} clear />
                <span className="text-xs text-fg-3">Tap a pod to tag it; tap again with the same label, or use Clear, to remove it.</span>
              </div>

              <figure className="m-0 flex min-w-0 flex-col gap-1.5">
                <div className={cn('grid grid-cols-1 gap-3', cameras.length > 1 && 'md:grid-cols-2')}>
                  {cameras.map(c => (
                    <div key={c} className="flex min-w-0 flex-col gap-1">
                      {shown === 'both' && (
                        <span className="text-xs text-fg-3">
                          {c === 'upper' ? 'Upper' : 'Lower'}
                          {frames[c] && <span className="font-mono text-[11px]">{` · ${fmtStamp((frames[c] as Frame).ts)}`}</span>}
                        </span>
                      )}
                      <Photo
                        camera={c}
                        frame={frames[c]}
                        regions={boxes(c)}
                        labelOf={s => labelOf(c, s)}
                        onTap={s => tap(c, s)}
                        compact={!single}
                        empty={single || !moment ? 'No photos from this camera yet.' : `No ${c} still this round.`}
                      />
                    </div>
                  ))}
                </div>
                <figcaption className="flex items-center gap-2 text-xs text-fg-3">
                  <GhostIcon icon={ChevronLeft} label="Older photo" disabled={!moment || !!pinned || step >= steps.length - 1} onClick={() => go(step + 1)} />
                  <span className="min-w-0 flex-1 text-center">
                    {moment && pictured.length
                      ? (
                          <>
                            <span className="font-mono text-[11px]">{fmtStamp(moment)}</span>
                            <span>{` · ${done} of ${slots.length} pods labelled`}</span>
                          </>
                        )
                      : '—'}
                  </span>
                  {/* From a capture older than the history, newer is the history's oldest. */}
                  <GhostIcon icon={ChevronRight} label="Newer photo" disabled={!pinned && step === 0} onClick={() => go(pinned ? steps.length - 1 : step - 1)} />
                </figcaption>
                {pinned && <span className="text-center text-xs text-fg-3">{`Older than the last ${HISTORY} photos: the arrows go back to them.`}</span>}
                {missed && <span className="text-center text-xs text-fg-3">That photo is no longer kept, so the newest is shown.</span>}
              </figure>
            </>
          )}
      {set.error && <InlineError>{set.error.message}</InlineError>}
    </div>
  )
}

/** A pod's crop, cut from its still with CSS: the still scaled so the pod's box fills the tile. */
function Crop({ entry, box }: { entry: Entry, box: PodRegions[number] }) {
  // The still's shape, so the tile has the pod's: 4:3 until it loads.
  const [ratio, setRatio] = useState(4 / 3)
  return (
    <div className="relative w-full overflow-hidden rounded-[6px] bg-code" style={{ aspectRatio: (box.w / box.h) * ratio }}>
      {entry.url
        ? (
            <img
              src={srcOf(entry.url, entry.url)}
              alt={`Pod ${entry.slot} at ${entry.ts}`}
              loading="lazy"
              className="absolute max-w-none"
              style={{ width: at(1 / box.w), height: at(1 / box.h), left: at(-box.x / box.w), top: at(-box.y / box.h) }}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                if (w > 0 && h > 0) setRatio(w / h)
              }}
            />
          )
        : <span className="flex size-full items-center justify-center p-2 text-center text-[11px] text-fg-3">Photo pruned</span>}
    </div>
  )
}

/** Every label as its pod's crop, newest photo first, filtered by label, to check, change or remove. */
function AllLabels({ boxes, counts, total, onOpen }: {
  boxes: (camera: Camera) => PodRegions
  counts: Record<PodLabelValue, number> | undefined
  total: number
  onOpen: (l: Entry) => void
}) {
  const utils = trpc.useUtils()
  const [filter, setFilter] = useState<PodLabelValue | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const list = trpc.vision.labelList.useInfiniteQuery({ label: filter ?? undefined, limit: PAGE }, { getNextPageParam: p => p.next ?? undefined })
  const set = trpc.vision.setLabel.useMutation({
    onSuccess: () => {
      setEditing(null)
      void utils.vision.invalidate()
    },
  })
  const rows = list.data?.pages.flatMap(p => p.labels) ?? []
  const keyOf = (l: Entry) => `${l.captureId}#${l.slot}`

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Show labels" className="flex flex-wrap gap-1.5">
        <Pill selected={filter === null} className="px-2.5 py-1 text-xs" onClick={() => setFilter(null)}>{`All ${total}`}</Pill>
        {POD_LABELS.map(l => (
          <Pill key={l} selected={filter === l} title={LABEL_MEANING[l]} className="flex items-center gap-1.5 px-2.5 py-1 text-xs" onClick={() => setFilter(l)}>
            <Dot label={l} />
            {`${name(l)} ${counts?.[l] ?? 0}`}
          </Pill>
        ))}
      </div>
      {rows.length === 0
        ? <p className="m-0 py-6 text-center text-[13px] text-fg-3">{list.isLoading ? 'Loading…' : filter ? `No pods labelled ${name(filter)} yet.` : 'No labels yet. Tag pods in Tag photos.'}</p>
        : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5" data-testid="all-labels">
              {rows.map((l) => {
                const k = keyOf(l)
                return (
                  <div key={k} data-testid="label-tile" className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-line p-1.5">
                    <button
                      type="button"
                      aria-label={`Open pod ${l.slot} at ${fmtStamp(l.ts)} in the tagger`}
                      disabled={!l.url}
                      className="block w-full cursor-pointer border-0 bg-transparent p-0 disabled:cursor-default"
                      onClick={() => onOpen(l)}
                    >
                      <Crop entry={l} box={boxes(l.camera)[l.slot] ?? { x: 0, y: 0, w: 1, h: 1 }} />
                    </button>
                    <div className="flex min-w-0 flex-col gap-0.5 px-0.5 text-xs">
                      <span className="flex items-center gap-1.5">
                        <Dot label={l.label} />
                        <span className="font-medium">{name(l.label)}</span>
                        <span className="ml-auto font-mono text-[11px] text-fg-3">{`Pod ${l.slot}`}</span>
                      </span>
                      <span className="truncate text-fg-2">{`${l.plant ?? 'No plant'}${l.daysSinceSowing === null ? '' : ` · day ${l.daysSinceSowing}`}`}</span>
                      <span className="font-mono text-[11px] text-fg-3">{fmtStamp(l.ts)}</span>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" className="px-2 py-1" aria-expanded={editing === k} onClick={() => setEditing(editing === k ? null : k)}>Change</Button>
                      <Button size="sm" variant="ghost" className="px-2 py-1" disabled={set.isPending} onClick={() => set.mutate({ captureId: l.captureId, slot: l.slot, label: null })}>Remove</Button>
                    </div>
                    {editing === k && (
                      <LabelChips
                        ariaLabel={`New label for pod ${l.slot}`}
                        value={l.label}
                        onPick={b => b !== 'clear' && b !== l.label && set.mutate({ captureId: l.captureId, slot: l.slot, label: b })}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
      {list.hasNextPage && (
        <Button size="sm" className="self-center" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
      {set.error && <InlineError>{set.error.message}</InlineError>}
    </div>
  )
}
