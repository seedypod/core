import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as RendererModule from './towerRenderer'
import type { TowerMount } from './towerRenderer'
import type { PodState, TowerPart, TowerTarget } from './towerScene'
import { TowerWireframe } from './TowerWireframe'

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
const LEGEND: { status: PodState['status'], token: string }[] = [
  { status: 'growing', token: 'var(--pod-ok)' },
  { status: 'harvest', token: 'var(--accent-light)' },
  { status: 'attention', token: 'var(--pod-attention)' },
  { status: 'seeded', token: 'var(--text-2)' },
]

/**
 * The tower in 3D (three.js, loaded on demand), filling the viewport's height.
 * Drag to turn it, ⌘/Ctrl-scroll to zoom, double-click to reset; click a pod to
 * pick it, or the light bars or tank to open their control (`onPart`). Hovering
 * names what's under the pointer. `controls` is a row of chips along the top;
 * the legend sits along the bottom. Calls `onUnavailable` without WebGL.
 */
export function TowerView({ pods, waterPct, lightLevel, pumpOn = false, selected = null, onSelect, onPart, partLabels, controls, onUnavailable }: {
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
  onUnavailable: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const mount = useRef<TowerMount | null>(null)
  const [hover, setHover] = useState<TowerTarget | null>(null)
  const [ready, setReady] = useState(false)
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
      })
    }).catch(() => latest.current.onUnavailable())
    return () => {
      alive = false
      mount.current?.dispose()
      mount.current = null
    }
  }, [podCount, preloaded])

  useEffect(() => {
    mount.current?.update({ pods, waterPct, lightLevel, pumpOn, hovered, selected })
  }, [pods, waterPct, lightLevel, pumpOn, hovered, selected, ready])

  const pod = hovered === null ? null : pods.find(p => p.slot === hovered)
  const partLabel = hover?.kind === 'part' && onPart ? partLabels?.[hover.part] : undefined
  return (
    <div ref={host} data-testid="tower-3d" className="relative h-[calc(100dvh-2.5rem)] min-h-[520px] w-full overflow-hidden rounded-xl border border-line bg-surface max-[900px]:h-[70dvh] max-[900px]:min-h-[440px]">
      <TowerWireframe pods={pods} podCount={podCount} fading={ready} />
      {!ready && <span className="sr-only" aria-live="polite">Loading the tower…</span>}
      {controls && <div className="absolute left-3 top-3 z-10 flex flex-wrap items-start gap-2">{controls}</div>}
      {(pod || partLabel) && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-ctl border border-line-2 bg-surface/95 px-3 py-2 text-sm shadow-[var(--shadow-dialog)]" role="status">
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
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-2">
        {LEGEND.map(l => (
          <span key={l.status} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: l.token }} />
            {STATUS_LABEL[l.status]}
          </span>
        ))}
        <span className="ml-auto text-fg-3 max-[600px]:hidden">Plant size follows measured growth · drag to turn · ⌘-scroll to zoom</span>
      </div>
    </div>
  )
}
