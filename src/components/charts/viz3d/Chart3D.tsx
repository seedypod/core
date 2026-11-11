/**
 * A 3D chart in a card (the five in ./scenes): made on mount, shown loading
 * until its request settles, handed its data on success and freed on unmount.
 * The box keeps the chart's aspect ratio from the first paint, so loading,
 * data, empty and error all sit in the same space. Drag it sideways to spin
 * it; a double click puts it back. Without WebGL, or if the
 * context can't be made or is lost, `fallback` (the flat chart) stands in.
 */
import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { hasWebGL } from '@/src/components/Grow/TowerView'
import type { Viz } from './base'
import type { VizState } from './motion'
import type * as Scenes from './scenes'
import type { LightData, PodsData, SensorsData, TankData, TodayData } from './shape'

export interface VizData { today: TodayData, tank: TankData, light: LightData, pods: PodsData, sensors: SensorsData }
export type VizKind = keyof VizData

const FACTORY = { today: 'createTodayViz', tank: 'createTankViz', light: 'createLightViz', pods: 'createPodsViz', sensors: 'createSensorsViz' } as const satisfies Record<VizKind, keyof typeof Scenes>
/** Each chart's shape; the scenes are framed for these. */
export const ASPECT: Record<VizKind, number> = { today: 3, tank: 2.4, light: 2.4, pods: 2.4, sensors: 2.5 }

let loading: Promise<typeof Scenes> | null = null
/** three.js and the scenes, fetched once, in their own chunk. */
export const loadScenes = () => (loading ??= import('./scenes'))

/** Where a chart stands from its requests: loading until each has data or failed, an error only with nothing to show. */
export function vizStatus(queries: ReadonlyArray<{ data?: unknown, error?: unknown, isLoading?: boolean }>, empty: boolean): VizState {
  if (queries.some(q => q.data === undefined && !q.error)) return 'loading'
  if (queries.some(q => q.error && q.data === undefined)) return 'error'
  return empty ? 'empty' : 'ready'
}

/** When the data shown was fetched, if a refresh has since failed: the chart stays, marked stale. */
export function staleSince(queries: ReadonlyArray<{ data?: unknown, error?: unknown, dataUpdatedAt?: number }>): number | null {
  const stale = queries.filter(q => q.error && q.data !== undefined && q.dataUpdatedAt)
  return stale.length ? Math.min(...stale.map(q => q.dataUpdatedAt as number)) : null
}

export function Chart3D<K extends VizKind>({ kind, data, status, label, message, fallback, onUnavailable, className }: {
  kind: K
  data: VizData[K] | null
  status: VizState
  /** Accessible name for the chart. */
  label: string
  /** Said in the middle of the chart when it's empty or failed. */
  message?: string
  fallback: ReactNode
  onUnavailable?: () => void
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const viz = useRef<Viz<VizData[K]> | null>(null)
  const [failed, setFailed] = useState(() => !hasWebGL())
  const shown = useRef<{ status: VizState | null, key: string }>({ status: null, key: '' })
  const latest = useRef({ data, status })
  useEffect(() => {
    latest.current = { data, status }
  })

  const apply = (v: Viz<VizData[K]>) => {
    const { data: d, status: s } = latest.current
    if (s === 'ready' && d) {
      // Data arrives as a fresh object each render; only a real change sweeps or tweens.
      const key = JSON.stringify(d)
      if (key === shown.current.key && shown.current.status === 'ready') return
      shown.current = { status: s, key }
      v.setData(d)
      return
    }
    if (s === shown.current.status) return
    shown.current = { status: s, key: s === 'loading' ? '' : shown.current.key }
    v.setState(s)
  }

  useEffect(() => {
    if (failed) onUnavailable?.()
  }, [failed, onUnavailable])

  useEffect(() => {
    const el = host.current
    if (failed || !el) return
    let alive = true
    const lost = (e: Event) => {
      e.preventDefault()
      setFailed(true)
    }
    // The canvas's context-lost event doesn't bubble; catch it on the way down.
    el.addEventListener('webglcontextlost', lost, true)
    loadScenes().then((mod) => {
      if (!alive) return
      const v = (mod[FACTORY[kind]] as (el: HTMLElement) => Viz<VizData[K]>)(el)
      viz.current = v
      shown.current = { status: null, key: '' }
      apply(v)
    }).catch(() => {
      if (alive) setFailed(true)
    })
    return () => {
      alive = false
      el.removeEventListener('webglcontextlost', lost, true)
      viz.current?.dispose()
      viz.current = null
    }
    // apply reads the latest props through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, failed])

  useEffect(() => {
    if (viz.current) apply(viz.current)
  })

  if (failed) return <>{fallback}</>
  const note = status === 'empty' || status === 'error' ? message : undefined
  return (
    <div
      ref={host}
      role="img"
      aria-label={label}
      aria-busy={status === 'loading'}
      data-testid={`viz-${kind}`}
      data-state={status}
      className={cn('relative w-full overflow-hidden', className)}
      style={{ aspectRatio: ASPECT[kind] }}
    >
      {note && <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center px-6 text-center text-[12px] text-fg-3">{note}</div>}
    </div>
  )
}

/** A header value while its chart loads: a pulsing block the size of `sample`, so nothing moves when the value lands. */
export function Pending({ loading, sample, children }: { loading: boolean, sample: string, children: ReactNode }) {
  if (!loading) return <>{children}</>
  return <span aria-hidden className="inline-block animate-pulse select-none rounded-[6px] bg-active text-transparent motion-reduce:animate-none">{sample}</span>
}

/**
 * A card's subtitle while its chart loads: no words, just a pulsing bar about
 * a line of text in size, so nothing shifts when the subtitle lands (the 3D
 * chart shows its own loading wave). Screen readers hear "Loading".
 */
export function LoadingLine({ className }: { className?: string }) {
  return (
    <span role="status" aria-live="polite" data-testid="loading-line" className={cn('inline-block h-[0.9em] w-40 max-w-full animate-pulse rounded-[4px] bg-active align-[-0.1em] motion-reduce:animate-none', className)}>
      <span className="sr-only">Loading</span>
    </span>
  )
}

/** The card header's note when the chart failed (with Retry) or is showing data older than a failed refresh. */
export function ChartNote({ status, stale, onRetry }: { status: VizState, stale: number | null, onRetry?: () => void }) {
  if (status === 'error') {
    return (
      <span className="flex items-center gap-2 text-[12px] text-danger" role="alert">
        Couldn&apos;t load
        {onRetry && (
          <button type="button" onClick={onRetry} className="flex cursor-pointer items-center gap-1 rounded-ctl border border-line-2 bg-transparent px-2 py-0.5 text-[12px] text-fg hover:bg-active">
            <RefreshCw size={12} />
            Retry
          </button>
        )}
      </span>
    )
  }
  if (stale !== null) return <span className="font-mono text-[11px] text-fg-3" data-testid="chart-stale">{`as of ${new Date(stale).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span>
  return null
}
