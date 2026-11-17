import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { VizSpot } from '@/src/components/charts/viz3d/base'
import { Chart3D, ChartNote, LoadingLine, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { podsData, type PodsData } from '@/src/components/charts/viz3d/shape'
import { fmtStamp } from '@/src/lib/timeAgo'
import { trpc } from '@/src/utils/trpc'
import { PodCard } from './PodCard'
import { podLabel } from './PodsTab'
import type { PodStory } from './pods'

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Without WebGL: each tower's pods as a column of bars, an empty or unmeasured pod a dash. */
function CoverBars({ data }: { data: PodsData | null }) {
  if (!data) return null
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-4" data-testid="leaf-cover-flat">
      {data.towers.map(t => (
        <div key={t.label} className="flex flex-col gap-1">
          <div className="font-mono text-[10px] font-medium tracking-[0.1em] text-fg-3">{t.label.toUpperCase()}</div>
          {t.pods.map((v, k) => (
            <div key={k} className="flex items-center gap-2 font-mono text-[11px] text-fg-3">
              <span className="relative h-1.5 flex-1 rounded-[3px] bg-active">
                {v !== null && <span className="absolute inset-y-0 left-0 rounded-[3px] bg-pod-ok" style={{ width: pct(v) }} />}
              </span>
              <span className={cn('w-8 text-right', v !== null && 'text-fg')}>{v === null ? '—' : pct(v)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** The card's width with its margins (PodCard is 230 px, m-1), and its gap from the pod. */
const CARD_W = 238
const GAP = 12

/** Where a pod's card starts across the chart: right of the pod in the chart's left half, left of it in the right half, kept inside. */
export function spotLeft(at: VizSpot): number {
  const left = at.x < at.width / 2 ? at.x + GAP : at.x - GAP - CARD_W
  return Math.max(0, Math.min(at.width - CARD_W, left))
}

/**
 * A pod's card beside its spot on the towers. Up and down, the space above
 * and below give way in proportion as the card grows, so it always spans the
 * pod's height and stays inside the chart while it fits.
 */
function SpotCard({ at, children }: { at: VizSpot, children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-y-0 z-10 flex flex-col" style={{ left: spotLeft(at), width: CARD_W }} data-testid="spot-card">
      <div style={{ flex: `0 1 ${at.y}px` }} />
      {children}
      <div style={{ flex: `0 1 ${at.height - at.y}px` }} />
    </div>
  )
}

/**
 * Leaf cover per pod from the primary analyser, tower by tower, with the
 * latest frame's time at the right; empty pods are bare grey stubs. Hovering,
 * focusing or tapping a pod shows its card as the photo does; a click pins it.
 */
export function LeafCover({ capturedAt, stories, pinned, onPick, onUnpin, onRelabel }: {
  capturedAt: string | null
  stories: Map<number, PodStory>
  pinned: number | null
  onPick: (slot: number) => void
  onUnpin: () => void
  onRelabel: () => void
}) {
  const pods = trpc.grow.pods.useQuery()
  const trends = trpc.vision.podTrends.useQuery()
  const queries = [pods, trends]
  const all = pods.data ?? []
  const green = new Map((trends.data ?? []).map(t => [t.slot, t.green]))
  const rows = all.map(p => ({ slot: p.slot, empty: p.status === 'empty', cover: green.get(p.slot) ?? null }))
  const measured = rows.filter(r => !r.empty && r.cover !== null).length
  const status = vizStatus(queries, all.length === 0)
  const scene = all.length ? podsData(rows) : null
  const pod = (slot: number) => all.find(p => p.slot === slot)
  const trend = (slot: number) => trends.data?.find(t => t.slot === slot)
  return (
    <section aria-label="Leaf cover per pod" className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
          <span className="text-[15px] font-medium">Leaf cover per pod</span>
          <span className="text-xs text-fg-3">
            {status === 'loading' ? <LoadingLine /> : 'Sphere size is leaf cover from the latest frame. Grey pods are empty.'}
          </span>
        </div>
        <ChartNote status={status} stale={staleSince(queries)} onRetry={() => queries.forEach(q => void q.refetch?.())} />
        {capturedAt && <span className="font-mono text-[11px] text-fg-3" data-testid="leaf-cover-frame">{fmtStamp(capturedAt)}</span>}
      </div>
      <Chart3D
        kind="pods"
        data={status === 'ready' ? scene : null}
        status={status}
        label={`Leaf cover per pod: ${measured} of ${all.length} measured`}
        message={status === 'error' ? 'Couldn\'t load the pods.' : 'No pods yet.'}
        fallback={<CoverBars data={scene} />}
        pick={{
          points: all.map(p => ({ id: p.slot, label: podLabel(p.slot, p, stories.get(p.slot), green.get(p.slot) ?? null) })),
          pinned,
          onPick,
          card: (slot, at) => (
            <SpotCard at={at}>
              <PodCard slot={slot} pod={pod(slot)} trend={trend(slot)} readings={[]} pinned={slot === pinned} onClose={onUnpin} story={stories.get(slot)} onRelabel={onRelabel} />
            </SpotCard>
          ),
        }}
      />
    </section>
  )
}
