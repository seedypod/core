import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as RendererModule from './towerRenderer'
import type { TowerMount } from './towerRenderer'
import type { PodHarvest, PodState, TowerPart, TowerTarget } from './towerScene'
import { TowerWireframe } from './TowerWireframe'
import { PlantThumb, podForm } from './PlantThumb'
import { heldFor, podShown, SHOWN_LABEL, SHOWN_TOKEN, STATUS_LABEL, STATUS_TOKEN } from './towerLayout'
import { cn } from '@/lib/utils'
import { Scissors, TriangleAlert, X } from 'lucide-react'

/**
 * Whether the browser has WebGL at all. A real probe would create a throwaway
 * GL context, which can block for seconds; the renderer's own context failing
 * is the real test, and it falls back the same way.
 */
export function hasWebGL(): boolean {
  return typeof window !== 'undefined' && typeof window.WebGLRenderingContext !== 'undefined'
}

let loading: Promise<typeof RendererModule> | null = null
/** Starts fetching the renderer (and three.js) once, without waiting for any data. */
export const loadRenderer = () => (loading ??= import('./towerRenderer'))

const LEGEND = (['growing', 'harvest', 'attention', 'seeded'] as const).map(status => ({ status, token: STATUS_TOKEN[status] }))
/** Room the readout needs beside its leader line before it flips to the other side. */
const LABEL_W = 280
/** The right-hand panel's width, and what it takes from the tower's room with its margin. */
const ASIDE_W = 300
const ASIDE_RESERVE = ASIDE_W + 24
const ASIDE_MIN = 900

const isFlagged = (p: PodState) => ['attention', 'ready'].includes(podShown(p))
/** Where a flag sits beside its pod's collar; a picked flagged pod's callout starts here. */
const FLAG_OFFSET = { x: 22, y: -22 }

/** A pod that wants doing something about, pinned to it whether or not it's picked; picked, it's ringed and its callout leads from it. */
function PodFlag({ pod, at, picked, onSelect }: { pod: PodState, at: { x: number, y: number }, picked: boolean, onSelect: (slot: number) => void }) {
  const shown = podShown(pod)
  const color = SHOWN_TOKEN[shown]
  const Icon = shown === 'ready' ? Scissors : TriangleAlert
  return (
    <button
      type="button"
      aria-label={`Pod ${pod.slot}: ${SHOWN_LABEL[shown]}`}
      aria-pressed={picked}
      onClick={() => onSelect(pod.slot)}
      className={cn('absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full shadow-[var(--shadow-dialog)] ring-2 ring-[var(--surface-app)]', picked ? 'z-[7] outline outline-2 outline-offset-2 outline-[var(--text-1)]' : 'z-[4]')}
      style={{ left: at.x + FLAG_OFFSET.x, top: at.y + FLAG_OFFSET.y, background: color }}
    >
      {shown === 'attention' && !picked && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: color }} />}
      <Icon size={11} strokeWidth={2.5} className="relative text-[var(--surface-card)]" />
    </button>
  )
}

/**
 * Where a pod sits in its grow (layout 1b): seeded at the left, grown so far
 * up to the harvest window, the window shaded, a tick for today. A window the
 * camera estimated reads "~".
 */
export function HarvestTimeline({ window: w, age }: { window: NonNullable<PodHarvest['window']>, age: number }) {
  const max = Math.max(w.end, age, 1)
  const x = (d: number) => `${(Math.max(0, Math.min(d, max)) / max) * 100}%`
  const about = w.source === 'camera' ? '~' : ''
  return (
    <div className="flex w-full flex-col gap-[7px]" role="img" aria-label={`Day ${Math.floor(age)}; harvest window ${about}${Math.round(w.start)}–${Math.round(w.end)} days`}>
      <div className="relative h-1.5 rounded-[3px] bg-line">
        <div className="absolute inset-y-0 left-0 rounded-l-[3px]" style={{ width: x(w.start), background: 'color-mix(in oklab, var(--pod-ok) 50%, transparent)' }} />
        <div className="absolute inset-y-0 rounded-r-[3px]" style={{ left: x(w.start), width: `calc(${x(w.end)} - ${x(w.start)})`, background: 'color-mix(in oklab, var(--pod-ready) 35%, transparent)' }} />
        <div data-testid="timeline-today" className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-[1px] bg-fg" style={{ left: x(age) }} />
      </div>
      <div className="relative h-3 whitespace-nowrap font-mono text-[10px] text-fg-3">
        <span className="absolute left-0">seeded</span>
        <span className="absolute -translate-x-1/2" style={{ left: x(w.start) }}>{`${about}${Math.round(w.start)} d`}</span>
        <span className="absolute -translate-x-full" style={{ left: x(w.end) }}>{`${about}${Math.round(w.end)} d`}</span>
      </div>
    </div>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * A pod's card, pinned to it by a leader line (sleepypod's bed callouts), in
 * the Pod Card board's layout 1b. Hovered, it names the pod and its state with
 * how long it has held, and offers the click to pin it. Pinned (the picked
 * pod), it adds where the pod sits in its grow, the state's reason as one
 * sentence, and `action`; `onClose` unpins it. The plant name is neutral and
 * the state carries the colour. It sits outward from the tower, on whichever
 * side has room, clear of the `reserve` pixels a panel covers.
 */
export function PodCallout({ pod, at: collar, width, height, reserve = 0, pinned = true, onClose, action, now }: { pod: PodState, at: { x: number, y: number }, width: number, height: number, reserve?: number, pinned?: boolean, onClose?: () => void, action?: ReactNode, now?: Date }) {
  const shown = podShown(pod)
  const color = SHOWN_TOKEN[shown]
  const flagged = isFlagged(pod)
  // A flagged pod's line leads from its flag, which marks it already; any other gets a ring on its collar.
  const at = flagged ? { x: collar.x + FLAG_OFFSET.x, y: collar.y + FLAG_OFFSET.y } : collar
  const room = (side: number) => (side > 0 ? width - reserve - at.x : at.x) - 124
  let side = at.x > (width - reserve) / 2 ? 1 : -1
  if (room(side) < LABEL_W && room(-side) > room(side)) side = -side
  const up = at.y > 140 ? -1 : 1
  // A long arm, so the card clears the neighbouring pods.
  const elbow = { x: at.x + side * 36, y: Math.min(height - 220, at.y + up * 48) }
  const end = { x: elbow.x + side * 88, y: elbow.y }
  const h = pod.harvest ?? null
  const age = typeof pod.ageDays === 'number' ? pod.ageDays : null
  const cover = h?.cover ?? (typeof pod.green === 'number' ? pod.green : null)
  const coverNote = cover === null || !h ? '' : `Leaf cover ${pct(cover)}, ${cover >= h.targetCover ? 'above' : 'behind'} the ${pct(h.targetCover)} target.`
  const note = pod.notes ? (/[.!?]$/.test(pod.notes.trim()) ? pod.notes.trim() : `${pod.notes.trim()}.`) : 'Marked for attention on Grow.'
  const sentence = shown === 'attention' ? [note, coverNote].filter(Boolean).join(' ') : h?.reason || coverNote
  const timeline = h?.window && age !== null && shown !== 'empty' ? h.window : null
  // A pod still growing says when it's due; any other, how long it has been as it is.
  const due = (shown === 'growing' || shown === 'soon') && typeof h?.daysToReady === 'number' && h.daysToReady > 0 ? `harvest in ~${Math.max(1, Math.round(h.daysToReady))} d` : null
  const timing = due ?? (shown === 'empty' ? null : heldFor(pod.statusSince, now))
  const details = pinned && (timeline || sentence || action)
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-[5] size-full" aria-hidden="true">
        <polyline points={`${at.x},${at.y} ${elbow.x},${elbow.y} ${end.x},${end.y}`} fill="none" stroke="var(--text-3)" strokeWidth={1} />
        {!flagged && (
          <>
            <circle cx={at.x} cy={at.y} r={10} fill="none" stroke="var(--text-1)" strokeWidth={1.5} />
            <circle cx={at.x} cy={at.y} r={3} fill="var(--text-1)" />
          </>
        )}
      </svg>
      <div
        data-testid="pod-callout"
        data-state={pinned ? 'pinned' : 'hover'}
        role="group"
        aria-label={`Pod ${pod.slot}`}
        className="absolute z-[6] flex w-[272px] flex-col gap-3 rounded-xl border border-line bg-surface/95 px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,.4)] backdrop-blur-md"
        style={side > 0 ? { top: end.y - 22, left: end.x } : { top: end.y - 22, right: width - end.x }}
      >
        <div className="flex items-start gap-2">
          <PlantThumb plant={pod.plant} stage={podForm(pod)} size={40} className="self-center" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="font-mono text-[11px] uppercase tracking-[.06em] text-fg-3">{`Pod ${pod.slot}`}</div>
            <div className="truncate text-[18px] font-medium text-fg">{pod.plant ?? 'Empty'}</div>
          </div>
          {pinned && onClose && (
            <button type="button" aria-label={`Close pod ${pod.slot}`} onClick={onClose} className="p-0.5 text-fg-3 hover:text-fg">
              <X size={16} strokeWidth={1.75} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="flex items-center gap-2 font-medium" style={{ color }}>
            <span className="size-[7px] rounded-full" style={{ background: color }} />
            {SHOWN_LABEL[shown]}
          </span>
          {timing && <span className="font-mono text-[11px] text-fg-3">{`· ${timing}`}</span>}
        </div>
        {details && (
          <div className="flex flex-col gap-3 border-t border-line pt-3">
            {timeline && age !== null && <HarvestTimeline window={timeline} age={age} />}
            {sentence && <p className="text-[13px] leading-normal text-pretty text-fg-2">{sentence}</p>}
            {action && <div className="flex gap-2">{action}</div>}
          </div>
        )}
        {!pinned && <div className="font-mono text-[10px] text-fg-3">Click to pin</div>}
      </div>
    </>
  )
}

/**
 * The tower in 3D (three.js, loaded on demand), filling the viewport's height.
 * Drag to turn it, ⌘/Ctrl-scroll to zoom, double-click to reset; click a pod to
 * pick it, or the light bars or tank to open their control (`onPart`). Hovering
 * names what's under the pointer and previews a pod's callout. The picked pod's
 * callout is pinned to it, with `podAction` under its readout, until `onClose`.
 * `controls` sits along the top left, `status` along the top right; the legend
 * (unless `legend` is false) and the hint along the bottom.
 * `aside` is a panel down the right on a wide view, with the tower moved over
 * to centre in the rest. Calls `onUnavailable` without WebGL.
 */
export function TowerView({ pods, waterPct, lightLevel, pumpOn = false, selected = null, onSelect, onClose, onPart, partLabels, controls, status, podAction, aside, legend = true, onUnavailable }: {
  pods: PodState[]
  waterPct: number | null
  lightLevel: number
  pumpOn?: boolean
  selected?: number | null
  onSelect: (slot: number) => void
  /** Unpins the picked pod's callout; without it the callout has no close button. */
  onClose?: () => void
  onPart?: (part: TowerPart) => void
  /** What hovering a part says, e.g. "Grow light · 77%". */
  partLabels?: Partial<Record<TowerPart, string>>
  controls?: ReactNode
  status?: ReactNode
  podAction?: ReactNode
  aside?: ReactNode
  legend?: boolean
  onUnavailable: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const mount = useRef<TowerMount | null>(null)
  const [hover, setHover] = useState<TowerTarget | null>(null)
  const [ready, setReady] = useState(false)
  const [anchors, setAnchors] = useState<{ width: number, height: number, at: Map<number, { x: number, y: number }> } | null>(null)
  // The pods with something pinned to them: the picked one, and any to harvest or seeing to.
  const pinned = useRef<number[]>([])
  const anchorKey = useRef('')
  const latest = useRef({ onSelect, onPart, onUnavailable, hasAside: aside != null })
  useEffect(() => {
    latest.current = { onSelect, onPart, onUnavailable, hasAside: aside != null }
  }, [onSelect, onPart, onUnavailable, aside])
  // A Home's 30 until the pods arrive, so the download and the data load at the same time.
  const podCount = pods.length || 30
  const [preloaded] = useState(() => (hasWebGL() ? loadRenderer().catch(() => null) : null))
  const hovered = hover?.kind === 'pod' ? hover.slot : null

  useEffect(() => {
    if (!hasWebGL()) {
      latest.current.onUnavailable()
      return
    }
    const el = host.current
    if (!el || !preloaded) return
    let alive = true
    void preloaded.then((mod) => {
      if (!alive) return
      if (!mod) throw new Error('the 3D view failed to load')
      const { mountTower } = mod
      mount.current = mountTower(el, {
        podCount,
        onHover: setHover,
        onSelect: (t) => {
          if (t.kind === 'pod') latest.current.onSelect(t.slot)
          else latest.current.onPart?.(t.part)
        },
        onReady: () => setReady(true),
        onFail: () => latest.current.onUnavailable(),
        reserveRight: w => (latest.current.hasAside && w >= ASIDE_MIN ? ASIDE_RESERVE : 0),
        // Follow the pinned pods as the tower turns; whole pixels, so a still frame doesn't re-render.
        onRender: () => {
          const at = new Map<number, { x: number, y: number }>()
          for (const slot of pinned.current) {
            const a = mount.current?.anchor(slot)
            if (a) at.set(slot, { x: Math.round(a.x), y: Math.round(a.y) })
          }
          const key = `${el.clientWidth}x${el.clientHeight}:${[...at].map(([k, v]) => `${k}@${v.x},${v.y}`).join(';')}`
          if (key === anchorKey.current) return
          anchorKey.current = key
          setAnchors({ width: el.clientWidth, height: el.clientHeight, at })
        },
      })
    }).catch(() => latest.current.onUnavailable())
    return () => {
      alive = false
      mount.current?.dispose()
      mount.current = null
    }
  }, [podCount, preloaded])

  useEffect(() => {
    pinned.current = pods.filter(p => p.slot === selected || p.slot === hovered || isFlagged(p)).map(p => p.slot)
    mount.current?.update({ pods, waterPct, lightLevel, pumpOn, hovered, selected })
  }, [pods, waterPct, lightLevel, pumpOn, hovered, selected, ready])

  // The picked pod has its callout, so hovering it adds nothing.
  // Hovering a pod previews its callout, in place of the picked one's until the pointer moves off.
  const shown = hovered ?? selected
  const shownPod = shown === null ? null : pods.find(p => p.slot === shown)
  const shownAt = shownPod ? anchors?.at.get(shownPod.slot) : undefined
  const partLabel = hover?.kind === 'part' && onPart ? partLabels?.[hover.part] : undefined
  return (
    <div ref={host} data-testid="tower-3d" className="@container relative h-[calc(100dvh-2.5rem)] min-h-[520px] w-full overflow-hidden rounded-xl border border-line bg-surface max-[900px]:h-[70dvh] max-[900px]:min-h-[440px]">
      <TowerWireframe pods={pods} podCount={podCount} fading={ready} />
      {!ready && <span className="sr-only" aria-live="polite">Loading the tower…</span>}
      {controls && <div className="absolute left-3 top-3 z-10 flex flex-wrap items-start gap-2">{controls}</div>}
      {ready && anchors && pods.filter(isFlagged).map((p) => {
        const at = anchors.at.get(p.slot)
        return at && <PodFlag key={p.slot} pod={p} at={at} picked={p.slot === selected} onSelect={onSelect} />
      })}
      {shownPod && ready && shownAt && anchors && <PodCallout pod={shownPod} at={shownAt} width={anchors.width} height={anchors.height} reserve={aside != null && anchors.width >= ASIDE_MIN ? ASIDE_RESERVE : 0} pinned={shownPod.slot === selected} onClose={onClose} action={shownPod.slot === selected ? podAction : undefined} />}
      {aside != null && <div className="absolute bottom-10 right-3 top-16 z-10 hidden flex-col @min-[900px]:flex" style={{ width: ASIDE_W }}>{aside}</div>}
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
        {status && <div className="pointer-events-auto flex flex-wrap items-start justify-end gap-2">{status}</div>}
        {partLabel && (
          <div className="rounded-ctl border border-line-2 bg-surface/95 px-3 py-2 text-sm shadow-[var(--shadow-dialog)]" role="status">
            <div>{partLabel}</div>
            <div className="text-xs text-fg-2">Click to adjust</div>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-[22px] bottom-4 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-2">
        {legend && LEGEND.map(l => (
          <span key={l.status} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: l.token }} />
            {STATUS_LABEL[l.status]}
          </span>
        ))}
        <span className={cn('font-mono text-fg-3 max-[600px]:hidden', legend && 'ml-auto')}>Click a pod · drag to turn · ⌘-scroll to zoom</span>
      </div>
    </div>
  )
}
