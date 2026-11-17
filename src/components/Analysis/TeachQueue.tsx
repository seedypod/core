import { Frame as FrameIcon, Sparkles } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { Button } from '@/src/components/ds/core'
import type { AppRouter } from '@/src/server/routers/app'
import { POD_LABELS } from '@/src/store/types'
import { trpc } from '@/src/utils/trpc'
import type { PodRegions } from '@/src/vision/regions'
import { codesWaiting } from './PodCodes'

type Camera = 'upper' | 'lower'
type Frame = inferRouterOutputs<AppRouter>['camera']['list'][number]
type Hint = inferRouterOutputs<AppRouter>['vision']['suggestions'][number]
type Stats = inferRouterOutputs<AppRouter>['vision']['labelStats']
export type BoxOff = inferRouterOutputs<AppRouter>['vision']['boxesOff'][number]

const card = 'flex min-w-0 flex-col gap-2 rounded-[12px] border border-line p-3.5'
/** A suggester as the grower reads it: `pod-state@2` is the pod-state model, whichever version. */
const suggester = (by: string) => by.split('@')[0] as string

/** A photo's suggestions still waiting on the grower: on a pod with a box, and no label yet. */
export function waiting(hints: Hint[] | undefined, labelled: Array<{ slot: number }> | undefined, regions: PodRegions): Hint[] {
  return (hints ?? []).filter(h => regions[h.slot] && !labelled?.some(l => l.slot === h.slot))
}

/** How many pods are labelled, and how often each suggester was right: `171 pods labelled · carry 82% right`. */
export function teachSummary(stats: Pick<Stats, 'pods' | 'suggesters'>): string {
  return [`${stats.pods} pod${stats.pods === 1 ? '' : 's'} labelled`, ...stats.suggesters.map(s => `${suggester(s.by)} ${Math.round(s.right * 100)}% right`)].join(' · ')
}

export interface TeachQueue {
  /** Suggestions waiting on each camera's newest still. */
  suggestions: number
  /** Read codes not confirmed yet. */
  codes: number
  /** Boxes that look off their pod. */
  boxes: BoxOff[]
  total: number
}

/**
 * Everything in Teach that waits on the grower, for the count on its tab:
 * the suggestions on each camera's newest still not yet labelled, the pod
 * codes not yet confirmed, and the boxes that look off their pod (a pod whose
 * suggestion was dismissed on photo after photo, its box never moved).
 */
export function useTeachQueue(frames: Record<Camera, Frame | undefined>, boxes: (camera: Camera) => PodRegions): TeachQueue {
  const hints = {
    upper: trpc.vision.suggestions.useQuery({ captureId: frames.upper?.id ?? '' }, { enabled: !!frames.upper }),
    lower: trpc.vision.suggestions.useQuery({ captureId: frames.lower?.id ?? '' }, { enabled: !!frames.lower }),
  }
  const labels = {
    upper: trpc.vision.labels.useQuery({ captureId: frames.upper?.id ?? '' }, { enabled: !!frames.upper }),
    lower: trpc.vision.labels.useQuery({ captureId: frames.lower?.id ?? '' }, { enabled: !!frames.lower }),
  }
  const codes = trpc.vision.podCodes.useQuery()
  const off = trpc.vision.boxesOff.useQuery()
  const cameras: Camera[] = ['upper', 'lower']
  const suggestions = cameras.reduce((n, c) => n + (frames[c] ? waiting(hints[c].data, labels[c].data, boxes(c)).length : 0), 0)
  const waitingCodes = codesWaiting(codes.data?.pods ?? [])
  const boxesOff = off.data ?? []
  return { suggestions, codes: waitingCodes, boxes: boxesOff, total: suggestions + waitingCodes + boxesOff.length }
}

/**
 * The suggestions on the photo in the tagger: how many and of what, how often
 * their suggesters were right on the labels already reviewed, Accept all to
 * save every one as shown, and Review one by one to tap them in turn.
 */
export function SuggestionsCard({ hints, suggesters, photos, pending, onAccept, onReview }: {
  hints: Hint[]
  suggesters: Stats['suggesters'] | undefined
  /** How many stills the tagger shows. */
  photos: number
  pending: boolean
  onAccept: () => void
  onReview: () => void
}) {
  const n = hints.length
  const by = [...new Set(hints.map(h => h.by))]
  const breakdown = POD_LABELS.map(l => [l, hints.filter(h => h.label === l).length] as const).filter(([, c]) => c > 0).map(([l, c]) => `${c} ${l}`).join(', ')
  const right = by.map((b) => {
    const s = suggesters?.find(x => x.by === b)
    return s ? `${suggester(b)} ${Math.round(s.right * 100)}% right` : `${suggester(b)} not checked yet`
  }).join(' · ')
  return (
    <section className={card} aria-label="Suggestions">
      <div className="flex items-baseline gap-2">
        <span className="flex flex-1 items-center gap-1.5 text-sm font-medium">
          <Sparkles size={14} className="self-center text-fg-3" />
          {photos > 1 ? 'Suggestions on these photos' : 'Suggestions on this photo'}
        </span>
        <span className="font-mono text-[11px] text-fg-3">{n}</span>
      </div>
      {n > 0
        ? (
            <>
              <span className="text-xs leading-[1.45] text-fg-2" data-testid="suggestion-breakdown">{`${breakdown}.`}</span>
              <span className="font-mono text-[11px] text-fg-3" data-testid="suggestion-sources">{right}</span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" disabled={pending} onClick={onAccept}>{`Accept all ${n}`}</Button>
                <Button size="sm" onClick={onReview}>Review one by one</Button>
              </div>
            </>
          )
        : <span className="text-xs text-fg-3">Nothing suggested waits here. Pick a label and tap pods to tag them.</span>}
    </section>
  )
}

/** The boxes that look off their pod, and Adjust boxes to open the bounds editor. */
export function BoundsCard({ off, onAdjust }: { off: BoxOff[], onAdjust: () => void }) {
  const n = off.length
  return (
    <section className={card} aria-label="Pod bounds">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <FrameIcon size={14} className="text-fg-3" />
            Pod bounds
          </span>
          <span className="text-xs text-fg-2" data-testid="bounds-summary">
            {n > 0 ? `${n} box${n === 1 ? ' looks' : 'es look'} off ${n === 1 ? 'its pod' : 'their pods'} (${off.map(b => b.slot).join(', ')})` : 'No box looks off its pod.'}
          </span>
          {n > 0 && <span className="text-[11px] text-fg-3">Suggestions dismissed on two photos or more this week. Move the box onto its cup, or remove it where the camera can&apos;t see the pod.</span>}
        </span>
        <Button size="sm" onClick={onAdjust}>Adjust boxes</Button>
      </div>
    </section>
  )
}
