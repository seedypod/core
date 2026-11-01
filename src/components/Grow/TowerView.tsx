import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as RendererModule from './towerRenderer'
import type { TowerMount } from './towerRenderer'
import type { PodState, TowerPart, TowerTarget } from './towerScene'
import { TowerWireframe } from './TowerWireframe'
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

const STATUS_LABEL: Record<PodState['status'], string> = { empty: 'Empty', seeded: 'Seeded', growing: 'Growing', harvest: 'Ready to harvest', attention: 'Needs attention' }
const STATUS_TOKEN: Record<PodState['status'], string> = {
  growing: 'var(--pod-ok)',
  harvest: 'var(--accent-light)',
  attention: 'var(--pod-attention)',
  seeded: 'var(--text-2)',
  empty: 'var(--text-3)',
}
const LEGEND = (['growing', 'harvest', 'attention', 'seeded'] as const).map(status => ({ status, token: STATUS_TOKEN[status] }))
const VERDICT: Record<'growing' | 'stalled' | 'declining', string> = { growing: '↑ Gaining', stalled: '→ Flat', declining: '↓ Shrinking' }
/** Room the readout needs beside its leader line before it flips to the other side. */
const LABEL_W = 200

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

/** A pod that wants doing something about, pinned to it before anyone picks it. */
function PodFlag({ pod, at, onSelect }: { pod: PodState, at: { x: number, y: number }, onSelect: (slot: number) => void }) {
  const color = STATUS_TOKEN[pod.status]
  const Icon = pod.status === 'harvest' ? Scissors : TriangleAlert
  return (
    <button
      type="button"
      aria-label={`Pod ${pod.slot}: ${STATUS_LABEL[pod.status]}`}
      onClick={() => onSelect(pod.slot)}
      className="absolute z-[4] grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full shadow-[var(--shadow-dialog)]"
      style={{ left: at.x + 16, top: at.y - 16, background: color }}
    >
      {pod.status === 'attention' && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: color }} />}
      <Icon size={11} strokeWidth={2.5} className="relative text-[var(--surface-card)]" />
    </button>
  )
}

/**
 * The picked pod's readout, pinned to it by a leader line (sleepypod's bed
 * callouts): the plant, its age and green area, the trend when there is one,
 * and its status, marked when it wants doing something about. It sits outward
 * from the tower, on whichever side has room.
 */
export function PodCallout({ pod, at, width, height, action }: { pod: PodState, at: { x: number, y: number }, width: number, height: number, action?: ReactNode }) {
  const color = STATUS_TOKEN[pod.status]
  const room = (side: number) => (side > 0 ? width - at.x : at.x) - 124
  let side = at.x > width / 2 ? 1 : -1
  if (room(side) < LABEL_W && room(-side) > room(side)) side = -side
  const up = at.y > 140 ? -1 : 1
  // A long arm, so the readout clears the neighbouring pods.
  const elbow = { x: at.x + side * 36, y: Math.min(height - 160, at.y + up * 48) }
  const end = { x: elbow.x + side * 88, y: elbow.y }
  const trend = pod.verdict && pod.verdict !== 'unknown' ? VERDICT[pod.verdict] : null
  const facts = [
    typeof pod.ageDays === 'number' ? `Day ${Math.floor(pod.ageDays)}` : null,
    typeof pod.green === 'number' ? `${Math.round(pod.green * 100)}% green` : null,
  ].filter(Boolean).join(' · ')
  const flagged = pod.status === 'harvest' || pod.status === 'attention'
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-[5] size-full" aria-hidden="true">
        <polyline points={`${at.x},${at.y} ${elbow.x},${elbow.y} ${end.x},${end.y}`} fill="none" stroke="var(--text-2)" strokeWidth={1.25} />
        <circle cx={at.x} cy={at.y} r={4.5} fill={color} stroke="var(--surface-card)" strokeWidth={1.5} />
      </svg>
      <div
        data-testid="pod-callout"
        role="group"
        aria-label={`Pod ${pod.slot}`}
        className={cn('absolute z-[6] flex max-w-[300px] flex-col gap-1.5 whitespace-nowrap rounded-xl border border-line-2 bg-surface/60 px-4 py-3 font-mono shadow-[var(--shadow-dialog)] backdrop-blur-xl backdrop-saturate-150', side > 0 ? 'items-start' : 'items-end')}
        style={side > 0 ? { top: end.y - 24, left: end.x } : { top: end.y - 24, right: width - end.x }}
      >
        <div className="text-[17px] leading-6" style={{ color }}>{pod.plant ?? 'Empty'}</div>
        {facts && <div className="text-[14px] text-fg">{facts}</div>}
        {trend && (
          <div className="flex items-center gap-1.5 text-[12px] text-fg-2">
            <Spark values={pod.recent ?? []} color={color} />
            {trend}
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px]">
          {pod.status !== 'empty' && (
            <span
              className={cn('rounded-full px-2 py-px', flagged ? 'border' : 'text-fg-2')}
              style={flagged ? { color, borderColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` } : undefined}
            >
              {STATUS_LABEL[pod.status]}
            </span>
          )}
          <span className="text-fg-3">{`Pod ${pod.slot}`}</span>
        </div>
        {pod.notes && <div className="max-w-full truncate text-[12px] text-fg-3">{pod.notes}</div>}
        {action && <div className="text-[12px]">{action}</div>}
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
 * Calls `onUnavailable` without WebGL.
 */
export function TowerView({ pods, waterPct, lightLevel, pumpOn = false, selected = null, onSelect, onPart, partLabels, controls, status, podAction, onUnavailable }: {
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
  const latest = useRef({ onSelect, onPart, onUnavailable })
  useEffect(() => {
    latest.current = { onSelect, onPart, onUnavailable }
  }, [onSelect, onPart, onUnavailable])
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
    pinned.current = pods.filter(p => p.slot === selected || p.status === 'harvest' || p.status === 'attention').map(p => p.slot)
    mount.current?.update({ pods, waterPct, lightLevel, pumpOn, hovered, selected })
  }, [pods, waterPct, lightLevel, pumpOn, hovered, selected, ready])

  // The picked pod has its callout, so hovering it adds nothing.
  const pod = hovered === null || hovered === selected ? null : pods.find(p => p.slot === hovered)
  const pickedPod = selected === null ? null : pods.find(p => p.slot === selected)
  const pickedAt = pickedPod ? anchors?.at.get(pickedPod.slot) : undefined
  const partLabel = hover?.kind === 'part' && onPart ? partLabels?.[hover.part] : undefined
  return (
    <div ref={host} data-testid="tower-3d" className="relative h-[calc(100dvh-2.5rem)] min-h-[520px] w-full overflow-hidden rounded-xl border border-line bg-surface max-[900px]:h-[70dvh] max-[900px]:min-h-[440px]">
      <TowerWireframe pods={pods} podCount={podCount} fading={ready} />
      {!ready && <span className="sr-only" aria-live="polite">Loading the tower…</span>}
      {controls && <div className="absolute left-3 top-3 z-10 flex flex-wrap items-start gap-2">{controls}</div>}
      {ready && anchors && pods.filter(p => p.slot !== selected && (p.status === 'harvest' || p.status === 'attention')).map((p) => {
        const at = anchors.at.get(p.slot)
        return at && <PodFlag key={p.slot} pod={p} at={at} onSelect={onSelect} />
      })}
      {pickedPod && ready && pickedAt && anchors && <PodCallout pod={pickedPod} at={pickedAt} width={anchors.width} height={anchors.height} action={podAction} />}
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
        {status && <div className="pointer-events-auto flex flex-wrap items-start justify-end gap-2">{status}</div>}
        {(pod || partLabel) && (
          <div className="rounded-ctl border border-line-2 bg-surface/95 px-3 py-2 text-sm shadow-[var(--shadow-dialog)]" role="status">
            {pod
              ? (
                  <>
                    <div className="font-mono text-[11px] text-fg-3">{`Pod ${pod.slot}`}</div>
                    <div>{pod.plant ?? 'Empty'}</div>
                    <div className="text-xs text-fg-2">
                      {STATUS_LABEL[pod.status]}
                      {typeof pod.green === 'number' ? ` · ${Math.round(pod.green * 100)}% green` : ''}
                    </div>
                  </>
                )
              : (
                  <>
                    <div>{partLabel}</div>
                    <div className="text-xs text-fg-2">Click to adjust</div>
                  </>
                )}
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
