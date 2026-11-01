import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as RendererModule from './towerRenderer'
import type { TowerMount } from './towerRenderer'
import type { PodHarvest, PodState, TowerPart, TowerTarget } from './towerScene'
import { TowerWireframe } from './TowerWireframe'
import { heldFor, podShown, SHOWN_LABEL, SHOWN_TOKEN, STATUS_LABEL, STATUS_TOKEN } from './towerLayout'
import { cn } from '@/lib/utils'
import { Scissors, TriangleAlert } from 'lucide-react'

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
const FLAG_OFFSET = { x: 16, y: -16 }

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
      className={cn('absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full shadow-[var(--shadow-dialog)]', picked ? 'z-[7] outline outline-2 outline-offset-2 outline-[var(--text-1)]' : 'z-[4]')}
      style={{ left: at.x + FLAG_OFFSET.x, top: at.y + FLAG_OFFSET.y, background: color }}
    >
      {shown === 'attention' && !picked && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: color }} />}
      <Icon size={11} strokeWidth={2.5} className="relative text-[var(--surface-card)]" />
    </button>
  )
}

/**
 * Where a pod sits in its grow (layout 1b): seeded at the left, the harvest
 * window shaded, a tick for today. A window the camera estimated reads "~".
 */
export function HarvestTimeline({ window: w, age }: { window: NonNullable<PodHarvest['window']>, age: number }) {
  const max = Math.max(w.end * 1.12, age * 1.04, 1)
  const x = (d: number) => `${(Math.max(0, Math.min(d, max)) / max) * 100}%`
  const about = w.source === 'camera' ? '~' : ''
  return (
    <div className="w-full pt-1" role="img" aria-label={`Day ${Math.floor(age)}; harvest window ${about}${Math.round(w.start)}–${Math.round(w.end)} days`}>
      <div className="relative h-1.5 rounded-full bg-[var(--border-2)]">
        <div className="absolute inset-y-0 left-0 rounded-l-full" style={{ width: x(w.start), background: 'var(--pod-ok)' }} />
        <div className="absolute inset-y-0" style={{ left: x(w.start), width: `calc(${x(w.end)} - ${x(w.start)})`, background: 'color-mix(in srgb, var(--accent-light) 60%, transparent)' }} />
        <div data-testid="timeline-today" className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded bg-[var(--text-1)]" style={{ left: x(age) }} />
      </div>
      <div className="relative mt-1.5 h-3 text-[10px] text-fg-3">
        <span className="absolute left-0">seeded</span>
        <span className="absolute -translate-x-1/2" style={{ left: x(w.start) }}>{`${about}${Math.round(w.start)} d`}</span>
        <span className="absolute -translate-x-full" style={{ left: x(w.end) }}>{`${about}${Math.round(w.end)} d`}</span>
      </div>
    </div>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * The picked pod's card, pinned to it by a leader line (sleepypod's bed
 * callouts). With a harvest window it leads with the timeline, then the state
 * as one sentence with its reason (1b); without one, the state with how long
 * it has held, then harvest and leaf cover against their targets (1a). Either
 * way the plant name is neutral, the state carries the colour, and `action`
 * (one primary action, then a link) ends it. It sits outward from the tower,
 * on whichever side has room, clear of the `reserve` pixels a panel covers.
 */
export function PodCallout({ pod, at: collar, width, height, reserve = 0, action, now }: { pod: PodState, at: { x: number, y: number }, width: number, height: number, reserve?: number, action?: ReactNode, now?: Date }) {
  const shown = podShown(pod)
  const color = SHOWN_TOKEN[shown]
  const flagged = isFlagged(pod)
  // A flagged pod's line leads from its flag, which marks it already; any other gets a dot on its collar.
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
  const sentence = shown === 'attention' ? [note, coverNote].filter(Boolean).join(' ') : h?.reason ?? ''
  const timeline = h?.window && age !== null && shown !== 'empty' ? h.window : null
  const harvestValue = h?.window ? `${h.window.source === 'camera' ? '~' : ''}${Math.round(h.window.start)}–${Math.round(h.window.end)} d` : typeof h?.daysToReady === 'number' && h.daysToReady > 0 ? `~${Math.round(h.daysToReady)} d` : '—'
  const harvestSub = h?.state === 'ready' && typeof h.daysLeft === 'number' ? `${Math.round(h.daysLeft)} d left` : typeof h?.daysToReady === 'number' && h.daysToReady > 0 ? `in ${Math.round(h.daysToReady)} d` : null
  const since = heldFor(pod.statusSince, now)
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-[5] size-full" aria-hidden="true">
        <polyline points={`${at.x},${at.y} ${elbow.x},${elbow.y} ${end.x},${end.y}`} fill="none" stroke="var(--text-2)" strokeWidth={1.25} />
        {!flagged && <circle cx={at.x} cy={at.y} r={4.5} fill={color} stroke="var(--surface-card)" strokeWidth={1.5} />}
      </svg>
      <div
        data-testid="pod-callout"
        data-layout={timeline ? 'timeline' : 'stats'}
        role="group"
        aria-label={`Pod ${pod.slot}`}
        className="absolute z-[6] flex w-[272px] flex-col gap-2 rounded-xl border border-line-2 bg-surface/60 px-4 py-3 font-mono shadow-[var(--shadow-dialog)] backdrop-blur-xl backdrop-saturate-150"
        style={side > 0 ? { top: end.y - 22, left: end.x } : { top: end.y - 22, right: width - end.x }}
      >
        {timeline && age !== null
          ? (
              <>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-fg-3">{`Pod ${pod.slot}`}</div>
                  <div className="truncate text-[17px] leading-6 text-fg">{pod.plant ?? 'Empty'}</div>
                </div>
                <HarvestTimeline window={timeline} age={age} />
                <div>
                  <div className="text-[13px]" style={{ color }}>{SHOWN_LABEL[shown]}</div>
                  {sentence && <p className="mt-1 text-[12px] leading-snug text-fg-2">{sentence}</p>}
                </div>
              </>
            )
          : (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[17px] leading-6 text-fg">{pod.plant ?? 'Empty'}</span>
                  <span className="shrink-0 text-[11px] uppercase tracking-wider text-fg-3">{`Pod ${pod.slot}`}</span>
                </div>
                {shown !== 'empty' && (
                  <div className="flex items-center gap-1.5 text-[12px]">
                    <span className="size-2 rounded-full" style={{ background: color }} />
                    <span style={{ color }}>{SHOWN_LABEL[shown]}</span>
                    {since && <span className="text-fg-3">{`· ${since}`}</span>}
                  </div>
                )}
                {shown === 'attention' && pod.notes && <p className="text-[12px] leading-snug text-fg-2">{pod.notes}</p>}
                {shown !== 'empty' && (
                  <dl className="grid grid-cols-2 gap-4 border-t border-line-2 pt-2">
                    <div>
                      <dt className="text-[10px] uppercase tracking-wider text-fg-3">Harvest</dt>
                      <dd className="text-[15px] text-fg">{harvestValue}</dd>
                      {harvestSub && <dd className="text-[11px] text-fg-3">{harvestSub}</dd>}
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wider text-fg-3">Leaf cover</dt>
                      <dd className="text-[15px] text-fg">{cover === null ? '—' : pct(cover)}</dd>
                      {h && <dd className="text-[11px] text-fg-3">{`target ${pct(h.targetCover)}`}</dd>}
                    </div>
                  </dl>
                )}
              </>
            )}
        {action && <div className="flex flex-col gap-2 pt-1 text-[12px]">{action}</div>}
      </div>
    </>
  )
}

/**
 * The tower in 3D (three.js, loaded on demand), filling the viewport's height.
 * Drag to turn it, ⌘/Ctrl-scroll to zoom, double-click to reset; click a pod to
 * pick it, or the light bars or tank to open their control (`onPart`). Hovering
 * names what's under the pointer. The picked pod gets a callout pinned to it,
 * with `podAction` under its readout. `controls` is a row of chips along the
 * top left, `status` along the top right; the legend sits along the bottom.
 * `aside` is a panel down the right on a wide view, with the tower moved over
 * to centre in the rest. Calls `onUnavailable` without WebGL.
 */
export function TowerView({ pods, waterPct, lightLevel, pumpOn = false, selected = null, onSelect, onPart, partLabels, controls, status, podAction, aside, onUnavailable }: {
  pods: PodState[]
  waterPct: number | null
  lightLevel: number
  pumpOn?: boolean
  selected?: number | null
  onSelect: (slot: number) => void
  onPart?: (part: TowerPart) => void
  /** What hovering a part says, e.g. "Grow light · 77%". */
  partLabels?: Partial<Record<TowerPart, string>>
  controls?: ReactNode
  status?: ReactNode
  podAction?: ReactNode
  aside?: ReactNode
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
      {shownPod && ready && shownAt && anchors && <PodCallout pod={shownPod} at={shownAt} width={anchors.width} height={anchors.height} reserve={aside != null && anchors.width >= ASIDE_MIN ? ASIDE_RESERVE : 0} action={shownPod.slot === selected ? podAction : undefined} />}
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
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-2">
        {LEGEND.map(l => (
          <span key={l.status} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: l.token }} />
            {STATUS_LABEL[l.status]}
          </span>
        ))}
        <span className="ml-auto text-fg-3 max-[600px]:hidden">Plant size follows measured growth · click a pod · drag to turn · ⌘-scroll to zoom</span>
      </div>
    </div>
  )
}
