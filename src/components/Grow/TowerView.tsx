import { useEffect, useRef, useState } from 'react'
import type { TowerMount } from './towerRenderer'
import type { PodState } from './towerScene'

export function hasWebGL(): boolean {
  if (typeof document === 'undefined' || typeof WebGLRenderingContext === 'undefined') return false
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  }
  catch {
    return false
  }
}

const STATUS_LABEL: Record<PodState['status'], string> = { empty: 'Empty', seeded: 'Seeded', growing: 'Growing', harvest: 'Ready to harvest', attention: 'Needs attention' }
const LEGEND: { status: PodState['status'], token: string }[] = [
  { status: 'growing', token: 'var(--pod-ok)' },
  { status: 'harvest', token: 'var(--accent-light)' },
  { status: 'attention', token: 'var(--pod-attention)' },
  { status: 'seeded', token: 'var(--text-2)' },
]

/**
 * The tower in 3D (three.js, loaded on demand). Drag to turn it, ⌘/Ctrl-scroll
 * to zoom, double-click to reset; click a pod to edit it. Calls `onUnavailable`
 * when there's no WebGL, so the page can fall back to the table.
 */
export function TowerView({ pods, waterPct, lightLevel, selected = null, onSelect, onUnavailable }: {
  pods: PodState[]
  waterPct: number | null
  lightLevel: number
  selected?: number | null
  onSelect: (slot: number) => void
  onUnavailable: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const mount = useRef<TowerMount | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const latest = useRef({ onSelect, onUnavailable })
  useEffect(() => {
    latest.current = { onSelect, onUnavailable }
  }, [onSelect, onUnavailable])
  const podCount = pods.length

  useEffect(() => {
    const el = host.current
    if (!el || !podCount) return
    if (!hasWebGL()) {
      latest.current.onUnavailable()
      return
    }
    let alive = true
    void import('./towerRenderer').then(({ mountTower }) => {
      if (!alive) return
      mount.current = mountTower(el, {
        podCount,
        onHover: setHovered,
        onSelect: slot => latest.current.onSelect(slot),
        onReady: () => setReady(true),
        onFail: () => latest.current.onUnavailable(),
      })
    }).catch(() => latest.current.onUnavailable())
    return () => {
      alive = false
      mount.current?.dispose()
      mount.current = null
    }
  }, [podCount])

  useEffect(() => {
    mount.current?.update({ pods, waterPct, lightLevel, hovered, selected })
  }, [pods, waterPct, lightLevel, hovered, selected, ready])

  const hover = hovered === null ? null : pods.find(p => p.slot === hovered)
  return (
    <div className="flex flex-col gap-2">
      <div ref={host} data-testid="tower-3d" className="relative h-[680px] w-full overflow-hidden rounded-xl border border-line bg-surface max-[600px]:h-[480px]">
        {!ready && <div className="absolute inset-0 grid place-items-center text-sm text-fg-3">Loading the tower…</div>}
        {hover && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-ctl border border-line-2 bg-surface px-3 py-2 text-sm shadow-[var(--shadow-dialog)]" role="status">
            <div className="font-mono text-[11px] text-fg-3">{`Pod ${hover.slot}`}</div>
            <div>{hover.plant ?? 'Empty'}</div>
            <div className="text-xs text-fg-2">
              {STATUS_LABEL[hover.status]}
              {typeof hover.green === 'number' ? ` · ${Math.round(hover.green * 100)}% green` : ''}
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute bottom-3 right-3 text-[11px] text-fg-3 max-[600px]:hidden">Drag to turn · ⌘-scroll to zoom · click a pod</div>
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-fg-2">
        {LEGEND.map(l => (
          <span key={l.status} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: l.token }} />
            {STATUS_LABEL[l.status]}
          </span>
        ))}
        <span className="text-fg-3">Plant size follows the measured green area.</span>
      </div>
    </div>
  )
}
