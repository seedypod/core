import { useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

/** The slider's stops: Auto, then off and the quarters. */
export const STOPS = ['auto', 0, 25, 50, 75, 100] as const
export type Stop = typeof STOPS[number]

const stopName = (s: Stop) => (s === 'auto' ? 'Auto' : s === 0 ? 'Off' : `${s}%`)
/** Where a level sits along the stops, between them when it isn't a quarter. */
const posOf = (v: Stop | number) => (v === 'auto' ? 0 : 1 + Math.max(0, Math.min(100, v)) / 25)
const pctOf = (pos: number) => (pos / (STOPS.length - 1)) * 100

/**
 * The light's stepped slider: Auto at the left, a dashed gap, then Off and
 * the quarters. `value` is 'auto' while Auto runs the light, or the level
 * the light is held at. A drag previews each level it crosses and picks the
 * stop it's let go on; a key picks the next stop straight away.
 */
export function LightStops({ value, auto, onPreview, onPick, className }: {
  value: Stop | number
  /** Whether Auto is the light's mode, which fills its dot. */
  auto: boolean
  /** A level crossed in a drag, to show before it's sent; null when a drag is called off. */
  onPreview: (level: number | null) => void
  onPick: (stop: Stop) => void
  className?: string
}) {
  const [at, setAt] = useState<number | null>(null)
  const drag = useRef<{ id: number, from: number } | null>(null)
  const shown = at === null ? posOf(value) : at
  const picked = at === null ? (value === 'auto' ? 0 : STOPS.indexOf(value as Stop)) : at
  const nearest = (e: PointerEvent<HTMLDivElement>) => {
    // The stops run between the thumb's centres at either end, 9 px in.
    const { left, width } = e.currentTarget.getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(1, (e.clientX - left - 9) / (width - 18 || 1))) * (STOPS.length - 1))
  }
  const move = (i: number) => {
    setAt(i)
    const s = STOPS[i] as Stop
    if (s !== 'auto') onPreview(s)
  }
  const index = Math.round(shown)
  const isAuto = shown === 0
  const level = isAuto ? 0 : (shown - 1) * 25
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div
        data-no-swipe
        data-testid="light-stops"
        className="relative h-[18px] cursor-pointer touch-pan-y select-none"
        onPointerDown={(e) => {
          if (drag.current || e.button !== 0) return
          drag.current = { id: e.pointerId, from: shown }
          e.currentTarget.setPointerCapture?.(e.pointerId)
          move(nearest(e))
        }}
        onPointerMove={e => drag.current?.id === e.pointerId && at !== nearest(e) && move(nearest(e))}
        onPointerUp={(e) => {
          const d = drag.current
          if (d?.id !== e.pointerId) return
          drag.current = null
          // Against where the drag began: the value by now may be the level it previewed.
          const i = at ?? index
          setAt(null)
          if (i !== d.from) onPick(STOPS[i] as Stop)
        }}
        // A swipe the page takes for a scroll: back to what the light is doing.
        onPointerCancel={() => {
          if (!drag.current) return
          drag.current = null
          setAt(null)
          onPreview(null)
        }}
      >
        {/* A 44 px target for a finger, without taking 44 px of layout. */}
        <div className="absolute -inset-x-2 -inset-y-[13px]" />
        <div className="absolute inset-y-0 inset-x-[9px]">
          <div className="absolute top-[8px] border-t border-dashed border-fg-3/60" style={{ left: 0, width: `${pctOf(1)}%` }} />
          <div className="absolute top-[7px] right-0 h-1 rounded-sm bg-line-2" style={{ left: `${pctOf(1)}%` }} />
          {!isAuto && <div data-testid="stops-fill" className="absolute top-[7px] h-1 rounded-sm bg-fg" style={{ left: `${pctOf(1)}%`, width: `${pctOf(shown) - pctOf(1)}%` }} />}
          {STOPS.slice(1).map((s, i) => (
            <span key={s} className={cn('absolute top-[4px] h-2.5 w-px -translate-x-1/2', posOf(s) <= shown && !isAuto ? 'bg-surface/60' : 'bg-fg-3')} style={{ left: `${pctOf(i + 1)}%` }} />
          ))}
          {/* Auto's dot: filled with a glow while it runs the light, a ring otherwise. */}
          <span
            data-testid="stops-auto"
            data-on={isAuto ? 'true' : undefined}
            className={cn('absolute top-1/2 box-border -translate-x-1/2 -translate-y-1/2 rounded-full', isAuto ? 'size-[18px] bg-light ring-4 ring-light/25' : cn('size-3 border-2 border-light', auto ? 'bg-light/30' : 'bg-surface'))}
            style={{ left: 0 }}
          />
          {!isAuto && (
            <span
              data-testid="stops-thumb"
              className={cn('absolute top-0 box-border size-[18px] rounded-full border-[3px] border-surface', level > 0 ? 'bg-fg' : 'bg-fg-3')}
              style={{ left: `calc(${pctOf(shown)}% - 9px)` }}
            />
          )}
        </div>
        <input
          type="range"
          aria-label="Brightness"
          aria-valuetext={at === null && value !== 'auto' && STOPS.indexOf(value as Stop) < 0 ? `${value}%` : stopName(STOPS[index] as Stop)}
          min={0}
          max={STOPS.length - 1}
          step={1}
          value={index}
          onChange={(e) => {
            const s = STOPS[Number(e.target.value)] as Stop
            if (s !== 'auto') onPreview(s)
            onPick(s)
          }}
          className="pointer-events-none absolute inset-0 m-0 !min-h-0 w-full opacity-0"
        />
      </div>
      <div className="pointer-events-none relative mx-[9px] h-4 font-mono text-[11px]" aria-hidden>
        {STOPS.map((s, i) => (
          <span
            key={s}
            className={cn('absolute whitespace-nowrap', i === 0 ? '' : i === STOPS.length - 1 ? '-translate-x-full' : '-translate-x-1/2', s === 'auto' ? 'text-light' : i === picked ? 'text-fg' : 'text-fg-3')}
            style={{ left: i === 0 ? -9 : i === STOPS.length - 1 ? 'calc(100% + 9px)' : `${pctOf(i)}%` }}
          >
            {s === 'auto' ? 'Auto' : s === 0 ? 'Off' : s}
          </span>
        ))}
      </div>
    </div>
  )
}
