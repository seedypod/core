import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { nameMatcher } from '@/src/components/Grow/plants/catalog'
import { fmtStamp } from '@/src/lib/timeAgo'
import { PLANTS, sproutWindow } from '@/src/plants/catalog'
import type { AppRouter } from '@/src/server/routers/app'
import type { PodLabelValue } from '@/src/store/types'
import { apiBase, trpc } from '@/src/utils/trpc'
import type { PodRegions } from '@/src/vision/regions'
import { LABEL_COLOR } from './LabelPods'
import { PodCard, type Pod, type Trend } from './PodCard'
import { podDay, podsSummary, podState, shortName, sprouting, windowText, type PodStory } from './pods'

type Outputs = inferRouterOutputs<AppRouter>
type Frame = Outputs['camera']['list'][number]
type Camera = 'upper' | 'lower'

const pct = (v: number) => `${Math.round(v * 100)}%`
const at = (n: number) => `${n * 100}%`
const title = (c: Camera) => (c === 'upper' ? 'Upper' : 'Lower')
/** A late pod's box, tag and row are amber. */
const LATE = 'var(--status-warn)'
/** The closest catalog plant to a pod's free-text name, for its sprouting window. */
const plantOf = nameMatcher([...PLANTS])
const LEGEND: Array<{ label: PodLabelValue, text: string }> = [{ label: 'seeded', text: 'seeded' }, { label: 'sprouted', text: 'sprouted' }, { label: 'growing', text: 'growing' }]

/** One camera's newest still. */
export interface Photo { camera: Camera, frame: Frame | undefined }

/** One still's labels and suggestions, by slot. */
function useShot(frame: Frame | undefined) {
  const enabled = !!frame
  const labels = trpc.vision.labels.useQuery({ captureId: frame?.id ?? '' }, { enabled })
  const hints = trpc.vision.suggestions.useQuery({ captureId: frame?.id ?? '' }, { enabled })
  return { labels: labels.data ?? [], hints: hints.data ?? [] }
}

/**
 * What the latest stills say about each pod (5a): its state from the
 * grower's labels, the tagger's suggestions and the pod record, its day and
 * sprouting window, and its confirmed yCube code; with the grow's day and
 * the page's summary.
 */
export function usePodStories(photos: Photo[], pods: Pod[]) {
  const upper = useShot(photos.find(p => p.camera === 'upper')?.frame)
  const lower = useShot(photos.find(p => p.camera === 'lower')?.frame)
  const grow = trpc.grow.current.useQuery()
  const codes = trpc.vision.podCodes.useQuery()
  const labels = [...upper.labels, ...lower.labels]
  const hints = [...upper.hints, ...lower.hints]
  const stories = new Map<number, PodStory>()
  for (const pod of pods) {
    const state = podState(pod, labels.find(l => l.slot === pod.slot), hints.find(h => h.slot === pod.slot))
    const day = state.stage === 'empty' ? null : podDay(pod.plantedAt)
    const plant = plantOf(pod.plant)
    const window = plant ? sproutWindow(plant) : null
    const code = codes.data?.pods.find(c => c.slot === pod.slot && c.confirmed)?.code ?? null
    stories.set(pod.slot, { state, day, window, sprout: sprouting(state.stage, day, window), code })
  }
  const day = grow.data?.day ?? null
  return { stories, summary: podsSummary(day, [...stories.values()].map(s => ({ stage: s.state.stage, sprout: s.sprout }))) }
}

/**
 * The Pods tab's photos (5a): each pod's box carries its number, plant and
 * leaf cover, coloured by its state, with `late?` for a seeded pod past its
 * plant's sprouting window. Empty pods are a faint dashed outline and their
 * number. Hovering, focusing or tapping a box opens its card; a click pins
 * it. Beside the photos, the planted pods as a list that pins the same way.
 */
export function PodsTab({ photos, boxes, pods, trends, stories, pinned, onPick, onUnpin, onRelabel }: {
  photos: Photo[]
  boxes: (camera: Camera) => PodRegions
  pods: Pod[]
  trends: Trend[]
  stories: Map<number, PodStory>
  pinned: number | null
  onPick: (slot: number) => void
  onUnpin: () => void
  onRelabel: () => void
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const shown = hovered ?? pinned
  const compact = photos.length > 1
  const slots = new Set(photos.flatMap(p => Object.keys(boxes(p.camera)).map(Number)))
  const listed = pods.filter(p => slots.has(p.slot)).sort((a, b) => a.slot - b.slot)
  return (
    <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className={cn('grid grid-cols-1 gap-3', compact && 'sm:grid-cols-2')}>
          {photos.map(p => (
            <PodPhoto
              key={p.camera}
              photo={p}
              boxes={boxes(p.camera)}
              pod={s => pods.find(x => x.slot === s)}
              trend={s => trends.find(t => t.slot === s)}
              story={s => stories.get(s)}
              shown={shown}
              pinned={pinned}
              compact={compact}
              onHover={setHovered}
              onPick={onPick}
              onUnpin={onUnpin}
              onRelabel={onRelabel}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] text-fg-3">
          {LEGEND.map(l => (
            <span key={l.label} className="flex items-center gap-[5px]">
              <span aria-hidden className="size-1.5 rounded-full" style={{ background: LABEL_COLOR[l.label] }} />
              {l.text}
            </span>
          ))}
          <span className="flex items-center gap-[5px]">
            <span aria-hidden className="size-1.5 rounded-full border border-dashed border-fg-3" />
            empty
          </span>
          <span className="flex items-center gap-[5px]">
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: LATE }} />
            late?
          </span>
        </div>
      </div>
      <PodList pods={listed} trends={trends} stories={stories} pinned={pinned} onPick={onPick} />
    </div>
  )
}

/** One camera's still with its pods' tagged boxes, and the card of the pod hovered or pinned. */
function PodPhoto({ photo, boxes, pod, trend, story, shown, pinned, compact, onHover, onPick, onUnpin, onRelabel }: {
  photo: Photo
  boxes: PodRegions
  pod: (slot: number) => Pod | undefined
  trend: (slot: number) => Trend | undefined
  story: (slot: number) => PodStory | undefined
  shown: number | null
  pinned: number | null
  /** Side by side, where only the number fits a tag. */
  compact: boolean
  onHover: (slot: number | null) => void
  onPick: (slot: number) => void
  onUnpin: () => void
  onRelabel: () => void
}) {
  const { camera, frame } = photo
  const [ratio, setRatio] = useState(4 / 3)
  const box = shown === null ? undefined : boxes[shown]
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      {/* Not clipped, so a pod's card can reach past the photo's edge. */}
      <div className="relative rounded-[10px] bg-code" style={{ aspectRatio: ratio }}>
        {frame
          ? (
              <>
                <img
                  src={frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`}
                  alt={`${camera} camera at ${frame.ts}`}
                  className="absolute inset-0 size-full rounded-[10px]"
                  onLoad={(e) => {
                    const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                    if (w > 0 && h > 0) setRatio(w / h)
                  }}
                />
                <div className="absolute inset-0" data-testid={`pod-boxes-${camera}`}>
                  {Object.entries(boxes).map(([slot, r]) => (
                    <PodBox key={slot} slot={Number(slot)} r={r} pod={pod(Number(slot))} trend={trend(Number(slot))} story={story(Number(slot))} selected={shown === Number(slot)} pinned={pinned === Number(slot)} compact={compact} onHover={onHover} onPick={onPick} />
                  ))}
                </div>
              </>
            )
          : <div className="flex size-full items-center justify-center p-4 text-center text-[13px] text-fg-3">No photos from this camera yet.</div>}
        {frame && shown !== null && box && (
          <PodCard slot={shown} box={box} pod={pod(shown)} trend={trend(shown)} readings={[]} pinned={shown === pinned} onClose={onUnpin} story={story(shown)} onRelabel={onRelabel} />
        )}
      </div>
      <figcaption className="flex flex-wrap gap-x-2 text-xs text-fg-3">
        <span className="text-fg-2">{title(camera)}</span>
        <span>{camera === 'upper' ? 'pods 1–15' : 'pods 16–30'}</span>
        {frame && <span className="ml-auto font-mono text-[11px]">{fmtStamp(frame.ts)}</span>}
      </figcaption>
    </figure>
  )
}

/** A pod's words for screen readers: `Pod 16, Perpetual Spinach, sprouted, 1% leaf cover`. */
export function podLabel(slot: number, pod: Pod | undefined, story: PodStory | undefined, cover: number | null): string {
  if (!story || story.state.stage === 'empty') return `Pod ${slot}, empty`
  return [`Pod ${slot}`, pod?.plant ?? 'unnamed', story.state.stage, cover !== null && `${pct(cover)} leaf cover`, story.sprout === 'late' && 'sprouting late'].filter(Boolean).join(', ')
}

/** A pod's box on the photo with its tag over it: hovering or focusing it shows its card, clicking (or tapping) pins it. */
function PodBox({ slot, r, pod, trend, story, selected, pinned, compact, onHover, onPick }: {
  slot: number
  r: { x: number, y: number, w: number, h: number }
  pod: Pod | undefined
  trend: Trend | undefined
  story: PodStory | undefined
  selected: boolean
  pinned: boolean
  compact: boolean
  onHover: (slot: number | null) => void
  onPick: (slot: number) => void
}) {
  const empty = !story || story.state.stage === 'empty'
  const late = story?.sprout === 'late'
  const color = empty ? undefined : late ? LATE : LABEL_COLOR[story.state.stage]
  const cover = trend?.green ?? null
  const words = !empty && [pod?.plant ? shortName(pod.plant) : null, late ? 'late?' : cover !== null ? pct(cover) : null].filter(Boolean).join(' · ')
  return (
    <>
      <button
        type="button"
        data-slot={slot}
        data-stage={story?.state.stage}
        data-late={late || undefined}
        aria-label={podLabel(slot, pod, story, cover)}
        aria-pressed={pinned}
        className={cn(
          'absolute cursor-pointer rounded-[4px] p-0 outline-none focus-visible:ring-2 focus-visible:ring-fg',
          empty ? 'border border-dashed border-fg-3/45 bg-transparent' : selected ? 'border-2 border-solid' : 'border-[1.5px] border-solid bg-transparent',
        )}
        style={{ left: at(r.x), top: at(r.y), width: at(r.w), height: at(r.h), ...(color && { borderColor: color }), ...(color && selected && { background: `color-mix(in oklab, ${color} 12%, transparent)` }) }}
        onPointerEnter={() => onHover(slot)}
        onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(slot)}
        onBlur={() => onHover(null)}
        onClick={() => onPick(slot)}
      />
      <span
        aria-hidden
        className={cn('pointer-events-none absolute flex -translate-y-full items-center gap-1 whitespace-nowrap rounded-[4px] px-[5px] py-[3px] font-mono text-[10px] font-medium leading-none', empty ? 'bg-code/55 text-fg-3' : 'border bg-surface/85 text-fg')}
        style={{ left: at(r.x), top: `calc(${at(r.y)} - 2px)`, ...(color && { borderColor: color }) }}
      >
        {!empty && <span className="size-1.5 shrink-0 rounded-full" style={{ background: LABEL_COLOR[story.state.stage] }} />}
        {slot}
        {/* The plant and cover don't fit a tag on a phone or beside the other camera. */}
        {words && !compact && <span className={cn('hidden sm:inline', late && 'text-warn')}>{` ${words}`}</span>}
        {words && compact && late && <span className="text-warn">?</span>}
      </span>
    </>
  )
}

/** The row's second line: `sprouted · day 8`, or why a seeded pod looks late. */
function rowSub(pod: Pod, story: PodStory | undefined): string {
  if (!story) return ''
  const { stage } = story.state
  if (story.sprout === 'late' && story.window) return `seeded · late, ${pod.plant ? shortName(pod.plant).toLowerCase() : 'it'} sprouts by day ${story.window.days[1]}`
  return [stage, story.day !== null && `day ${story.day}`].filter(Boolean).join(' · ')
}

/** The planted pods on the shown photos, with the empty ones on request; a row pins its pod like its box does. */
function PodList({ pods, trends, stories, pinned, onPick }: {
  pods: Pod[]
  trends: Trend[]
  stories: Map<number, PodStory>
  pinned: number | null
  onPick: (slot: number) => void
}) {
  const [all, setAll] = useState(false)
  const empty = (p: Pod) => (stories.get(p.slot)?.state.stage ?? 'empty') === 'empty'
  const planted = pods.filter(p => !empty(p))
  const spare = pods.length - planted.length
  const rows = all ? pods : planted
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="pod-list">
      <div className="flex items-baseline gap-2">
        <span className="flex-1 font-mono text-[10px] font-medium tracking-[0.1em] text-fg-3">{`PLANTED · ${planted.length}`}</span>
        {spare > 0 && (
          <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11px] text-fg-3 underline hover:text-fg" aria-expanded={all} onClick={() => setAll(a => !a)}>
            {all ? 'Hide empty' : `+ ${spare} empty`}
          </button>
        )}
      </div>
      {rows.length === 0 && <p className="text-[13px] text-fg-2">No pods are planted.</p>}
      <div className="flex flex-col">
        {rows.map((p) => {
          const story = stories.get(p.slot)
          const stage = story?.state.stage ?? 'empty'
          const late = story?.sprout === 'late'
          const cover = trends.find(t => t.slot === p.slot)?.green ?? null
          return (
            <button
              key={p.slot}
              type="button"
              aria-pressed={pinned === p.slot}
              className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 px-2.5 py-[7px] text-left text-fg', pinned === p.slot ? 'bg-active shadow-[inset_0_0_0_1px_var(--border-2)]' : 'bg-transparent hover:bg-active/60')}
              onClick={() => onPick(p.slot)}
            >
              <span className="w-5 font-mono text-[11px] text-fg-3">{p.slot}</span>
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', stage === 'empty' && 'border border-dashed border-fg-3')} style={stage === 'empty' ? undefined : { background: LABEL_COLOR[stage] }} />
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-xs">{stage === 'empty' ? 'Empty' : p.plant ?? 'Unnamed'}</span>
                {stage !== 'empty' && <span className={cn('truncate text-[11px]', late ? 'text-warn' : 'text-fg-3')} title={late && story?.window ? windowText(story.window) : undefined}>{rowSub(p, story)}</span>}
              </span>
              {stage !== 'empty' && <span className="font-mono text-xs">{cover === null ? '—' : pct(cover)}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
