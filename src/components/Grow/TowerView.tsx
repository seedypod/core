import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as RendererModule from './towerRenderer'
import type { TowerMount } from './towerRenderer'
import type { PodState, TowerPart, TowerTarget } from './towerScene'
import { TowerWireframe } from './TowerWireframe'
import { STATUS_LABEL, STATUS_TOKEN } from './towerLayout'
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
const VERDICT: Record<'growing' | 'stalled' | 'declining', string> = { growing: '↑ Gaining', stalled: '→ Flat', declining: '↓ Shrinking' }
/** Room the readout needs beside its leader line before it flips to the other side. */
const LABEL_W = 200
/** The right-hand panel's width, and what it takes from the tower's room with its margin. */
const ASIDE_W = 300
const ASIDE_RESERVE = ASIDE_W + 24
const ASIDE_MIN = 900

/** Green area over the last few photos, scaled to its own range so small changes still show. */
function Spark({ values, color }: { values: number[], color: string }) {
  if (values.length < 3) return null
  const lo = Math.min(...values)
  const span = Math.max(...values) - lo || 1
  const xy = values.map((v, i) => [(i / (values.length - 1)) * 60 + 2, 16 - ((v - lo) / span) * 13] as const)
  const [lx, ly] = xy[xy.length - 1]
  return (
    <svg width={64} height={18} aria-hidden="true" className="shrink-0">
      <polyline points={xy.map(p => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2.25} fill={color} />
    </svg>
  )
}

const isFlagged = (p: PodState) => p.status === 'harvest' || p.status === 'attention'
/** Where a flag sits beside its pod's collar; a picked flagged pod's callout starts here. */
const FLAG_OFFSET = { x: 16, y: -16 }

/** A pod that wants doing something about, pinned to it whether or not it's picked; picked, it's ringed and its callout leads from it. */
function PodFlag({ pod, at, picked, onSelect }: { pod: PodState, at: { x: number, y: number }, picked: boolean, onSelect: (slot: number) => void }) {
  const color = STATUS_TOKEN[pod.status]
  const Icon = pod.status === 'harvest' ? Scissors : TriangleAlert
  return (
    <button
      type="button"
      aria-label={`Pod ${pod.slot}: ${STATUS_LABEL[pod.status]}`}
      aria-pressed={picked}
      onClick={() => onSelect(pod.slot)}
      className={cn('absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full shadow-[var(--shadow-dialog)]', picked ? 'z-[7] outline outline-2 outline-offset-2 outline-[var(--text-1)]' : 'z-[4]')}
      style={{ left: at.x + FLAG_OFFSET.x, top: at.y + FLAG_OFFSET.y, background: color }}
    >
      {pod.status === 'attention' && !picked && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: color }} />}
      <Icon size={11} strokeWidth={2.5} className="relative text-[var(--surface-card)]" />
    </button>
  )
}

/**
 * The picked pod's readout, pinned to it by a leader line (sleepypod's bed
 * callouts): the plant, its age and green area, the trend when there is one,
 * and its status, marked when it wants doing something about. It sits outward
 * from the tower, on whichever side has room, clear of the `reserve` pixels a
 * panel covers on the right.
 */
export function PodCallout({ pod, at: collar, width, height, reserve = 0, action }: { pod: PodState, at: { x: number, y: number }, width: number, height: number, reserve?: number, action?: ReactNode }) {
  const color = STATUS_TOKEN[pod.status]
  const flagged = isFlagged(pod)
  // A flagged pod's line leads from its flag, which marks it already; any other gets a dot on its collar.
  const at = flagged ? { x: collar.x + FLAG_OFFSET.x, y: collar.y + FLAG_OFFSET.y } : collar
  const room = (side: number) => (side > 0 ? width - reserve - at.x : at.x) - 124
  let side = at.x > (width - reserve) / 2 ? 1 : -1
  if (room(side) < LABEL_W && room(-side) > room(side)) side = -side
  const up = at.y > 140 ? -1 : 1
  // A long arm, so the readout clears the neighbouring pods.
  const elbow = { x: at.x + side * 36, y: Math.min(height - 160, at.y + up * 48) }
  const end = { x: elbow.x + side * 88, y: elbow.y }
  const trend = pod.verdict && pod.verdict !== 'unknown' ? VERDICT[pod.verdict] : null
  const stats: { label: string, value: ReactNode }[] = []
  if (typeof pod.ageDays === 'number') stats.push({ label: 'Age', value: `${Math.floor(pod.ageDays)} d` })
  if (typeof pod.green === 'number') stats.push({ label: 'Green', value: `${Math.round(pod.green * 100)}%` })
  if (trend) {
    stats.push({ label: 'Trend', value: (
      <span className="flex items-center gap-1.5">
        <Spark values={pod.recent ?? []} color={color} />
        {trend}
      </span>
    ) })
  }
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-[5] size-full" aria-hidden="true">
        <polyline points={`${at.x},${at.y} ${elbow.x},${elbow.y} ${end.x},${end.y}`} fill="none" stroke="var(--text-2)" strokeWidth={1.25} />
        {!flagged && <circle cx={at.x} cy={at.y} r={4.5} fill={color} stroke="var(--surface-card)" strokeWidth={1.5} />}
      </svg>
      <div
        data-testid="pod-callout"
        role="group"
        aria-label={`Pod ${pod.slot}`}
        className={cn('absolute z-[6] flex max-w-[300px] flex-col gap-1.5 whitespace-nowrap rounded-xl border border-line-2 bg-surface/60 px-4 py-3 font-mono shadow-[var(--shadow-dialog)] backdrop-blur-xl backdrop-saturate-150', side > 0 ? 'items-start' : 'items-end')}
        style={side > 0 ? { top: end.y - 40, left: end.x } : { top: end.y - 40, right: width - end.x }}
      >
        {/* Which pod, what's in it and what state it's in; then how it's doing; then what to do. */}
        <div className="text-[11px] uppercase tracking-wider text-fg-3">{`Pod ${pod.slot}`}</div>
        <div className="text-[17px] leading-6" style={{ color }}>{pod.plant ?? 'Empty'}</div>
        {pod.status !== 'empty' && (
          <span
            className={cn('rounded-full text-[11px]', flagged ? 'border px-2 py-px' : 'text-fg-2')}
            style={flagged ? { color, borderColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` } : undefined}
          >
            {STATUS_LABEL[pod.status]}
          </span>
        )}
        {stats.length > 0 && (
          <dl className={cn('mt-1.5 flex gap-5', side > 0 ? 'text-left' : 'text-right')}>
            {stats.map(st => (
              <div key={st.label} className="flex flex-col gap-0.5">
                <dt className="text-[10px] uppercase tracking-wider text-fg-3">{st.label}</dt>
                <dd className="text-[14px] text-fg">{st.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {pod.notes && <div className="mt-0.5 max-w-full truncate text-[12px] text-fg-2">{pod.notes}</div>}
        {action && <div className="mt-2 w-full border-t border-line-2 pt-2.5 text-[12px]">{action}</div>}
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
