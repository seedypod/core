import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import type { Rect } from '@/src/vision/greenArea'
import { clampRegion, type PodRegions } from '@/src/vision/regions'

/** How far an arrow key moves or resizes a box, as a fraction of the frame. */
export const STEP = 0.005
const at = (n: number) => `${n * 100}%`
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

/** Move a box, or resize it from its bottom-right corner, by a fraction of the frame, keeping it inside. */
export function nudge(r: Rect, mode: 'move' | 'size', dx: number, dy: number): Rect {
  if (mode === 'move') return clampRegion({ ...r, x: r.x + dx, y: r.y + dy })
  return clampRegion({ ...r, w: Math.min(1 - r.x, r.w + dx), h: Math.min(1 - r.y, r.h + dy) })
}

interface Drag { slot: number, mode: 'move' | 'size', x0: number, y0: number, start: Rect, width: number, height: number }

/**
 * The box each pod is scored on, and the dashed middle third a plant must grow
 * from (#132), drawn over a still as the analysers use them. With `onChange`
 * the boxes can be calibrated (#143): drag one to move it, its corner to resize
 * it, or focus one and use the arrow keys (Shift resizes).
 */
export function PodBounds({ boxes, label, onChange }: { boxes: PodRegions, label?: (slot: number) => string | undefined, onChange?: (slot: number, r: Rect) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const editing = !!onChange

  const start = (slot: number, mode: Drag['mode']) => (e: PointerEvent<HTMLElement>) => {
    const frame = ref.current?.getBoundingClientRect()
    const box = boxes[slot]
    if (!frame || frame.width === 0 || frame.height === 0 || !box) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { slot, mode, x0: e.clientX, y0: e.clientY, start: box, width: frame.width, height: frame.height }
  }
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    onChange?.(d.slot, nudge(d.start, d.mode, (e.clientX - d.x0) / d.width, (e.clientY - d.y0) / d.height))
  }
  const end = () => {
    drag.current = null
  }
  const key = (slot: number) => (e: KeyboardEvent<HTMLElement>) => {
    const arrow = ARROWS[e.key]
    const box = boxes[slot]
    if (!arrow || !box) return
    e.preventDefault()
    onChange?.(slot, nudge(box, e.shiftKey ? 'size' : 'move', arrow[0] * STEP, arrow[1] * STEP))
  }

  return (
    <div ref={ref} className={cn('absolute inset-0', editing ? 'touch-none' : 'pointer-events-none')} data-testid="pod-bounds" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {Object.entries(boxes).map(([slot, r]) => {
        const s = Number(slot)
        const v = label?.(s)
        const place = { left: at(r.x), top: at(r.y), width: at(r.w), height: at(r.h) }
        const tag = <span className="absolute left-0 top-0 rounded-br-[4px] bg-pod-ready px-1 font-mono text-[10px] leading-[14px] text-inverse">{v ? `${slot} · ${v}` : slot}</span>
        const core = <span className="absolute inset-[33.333%] border border-dashed border-pod-ready/80" />
        return editing
          ? (
              <div
                key={slot}
                data-slot={slot}
                role="button"
                tabIndex={0}
                aria-label={`Pod ${slot} box`}
                className="absolute cursor-move border-[1.5px] border-pod-ready bg-pod-ready/10 outline-none focus-visible:border-fg"
                style={place}
                onPointerDown={start(s, 'move')}
                onKeyDown={key(s)}
              >
                {core}
                {tag}
                <span data-handle={slot} aria-hidden className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-[3px] border border-inverse bg-pod-ready" onPointerDown={start(s, 'size')} />
              </div>
            )
          : (
              <div key={slot} data-slot={slot} className="absolute border-[1.5px] border-pod-ready" style={place}>
                {core}
                {tag}
              </div>
            )
      })}
    </div>
  )
}
