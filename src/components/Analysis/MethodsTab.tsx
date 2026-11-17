import { ArrowLeft, RefreshCw } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useId, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { TimeChart } from '@/src/components/charts/TimeChart'
import { InlineError } from '@/src/components/ds/core'
import { fmtStamp } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import type { PodLabelValue, PodStatus } from '@/src/store/types'
import { apiBase, trpc } from '@/src/utils/trpc'
import { AGREE_GREEN, agrees } from '@/src/vision/agreement'
import { POD_STATES } from '@/src/vision/podState'
import { cameraOf, type PodRegions } from '@/src/vision/regions'
import { Agreement } from './Agreement'
import { AllPods } from './AllPods'
import type { Pod, Trend } from './PodCard'

const pct = (v: number) => `${Math.round(v * 100)}%`
const key = (a: { analyzer: string, version: number }) => `${a.analyzer}@${a.version}`
const listingKey = (a: Listing) => key({ analyzer: a.id, version: a.version })
const at = (n: number) => `${n * 100}%`
const srcOf = (path: string, url: string) => (path.startsWith('data:') ? path : `${apiBase()}${url}`)
/** Under this green area a pod reads as having no plant up, as in the agreement with labels. */
const NO_PLANT = 0.02
/** How many photos the strip under the chart shows: each is a full still on a Pi Zero, so few. */
const STRIP = 5

type Listing = inferRouterOutputs<AppRouter>['vision']['analyzers'][number]
type Camera = 'upper' | 'lower'

function Panel({ className, children }: { className?: string, children: ReactNode }) {
  return <div className={cn('flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-5', className)}>{children}</div>
}

/**
 * Methods: every analyser version as a row to pick the primary from and
 * re-run, one pod across the versions with the photos behind the lines, and
 * how often each version agrees with the grower's labels.
 */
export function MethodsTab({ analyzers, colorOf, busy, slot, onSlot, pods, trends, boxes }: {
  analyzers: Listing[]
  colorOf: (k: string) => string
  busy: boolean
  slot: number
  onSlot: (slot: number) => void
  pods: Pod[]
  trends: Trend[]
  boxes: (camera: Camera) => PodRegions
}) {
  return (
    <>
      {analyzers.length > 0 && <MethodRows analyzers={analyzers} colorOf={colorOf} busy={busy} />}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <PodOverTime colorOf={colorOf} slot={slot} onSlot={onSlot} pods={pods} trends={trends} boxes={boxes} />
        <Agreement analyzers={analyzers} colorOf={colorOf} />
      </div>
    </>
  )
}

/** Whether an analyser can drive pod trends: it measures green area, or says nothing of what it measures. */
const canBePrimary = (a: Listing) => a.metrics.length === 0 || a.metrics.some(m => m.name === 'green_fraction')

/** Each analyser version as a row: the primary picked by its radio, what it is, how much it has scored, and a re-run. */
function MethodRows({ analyzers, colorOf, busy }: { analyzers: Listing[], colorOf: (k: string) => string, busy: boolean }) {
  const utils = trpc.useUtils()
  const primary = trpc.vision.setPrimary.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const rerun = trpc.vision.rerun.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const uid = useId()
  const action = 'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border border-line-2 bg-transparent px-2 py-1 text-[11px] text-fg hover:bg-active disabled:cursor-default disabled:opacity-45'
  return (
    <div className="flex flex-col gap-2">
      <fieldset className="m-0 flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface p-0">
        <legend className="sr-only">Primary method</legend>
        {analyzers.map((a, i) => {
          const k = listingKey(a)
          const id = `${uid}-${i}`
          const current = a.source === 'device' && a.runsOn.includes('device') && !a.disabled
          return (
            <div key={k} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5', i > 0 && 'border-t border-line', a.primary && 'bg-active')}>
              {/* Full width on a phone, so the count and Re-run wrap under it. */}
              <label className={cn('flex w-full min-w-0 items-start gap-3 sm:w-auto sm:flex-1', canBePrimary(a) ? 'cursor-pointer' : 'cursor-default')}>
                <input
                  type="radio"
                  name={`${uid}-primary`}
                  aria-labelledby={`${id}-name`}
                  aria-describedby={`${id}-sub`}
                  className="mt-[3px] shrink-0 accent-[var(--pod-ok)]"
                  checked={a.primary}
                  disabled={!canBePrimary(a) || primary.isPending}
                  onChange={() => primary.mutate({ analyzer: a.id })}
                />
                <span aria-hidden="true" className="mt-[9px] h-[3px] w-3 shrink-0 rounded-[2px]" style={{ background: colorOf(k) }} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span id={`${id}-name`} className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="font-mono text-[13px]">{k}</span>
                    {' '}
                    <span className="text-xs text-fg-2">{a.label}</span>
                  </span>
                  {/* Two lines of the description, all of it on hover and to a screen reader; why it's off in full. */}
                  <span id={`${id}-sub`} title={a.disabled ? undefined : a.description} className={cn('text-[11px] leading-snug text-pretty', a.disabled ? 'text-fg-2' : 'line-clamp-2 text-fg-3')}>
                    {a.disabled ? `Off. ${a.disabled}` : a.description}
                  </span>
                </span>
              </label>
              <span className="ml-auto font-mono text-[11px] text-fg-3" title={a.lastTs ? `last ${new Date(a.lastTs).toLocaleString()}` : undefined}>
                {[a.captures > 0 ? `${a.captures} captures` : 'No results yet', a.source === 'remote' && 'remote'].filter(Boolean).join(' · ')}
              </span>
              {current && (
                <button type="button" aria-label={`Re-run ${k}`} className={action} disabled={busy || rerun.isPending} onClick={() => rerun.mutate({ analyzer: a.id, limit: 2000 })}>
                  <RefreshCw size={12} />
                  Re-run
                </button>
              )}
            </div>
          )
        })}
      </fieldset>
      <p className="px-1 text-xs text-fg-3">The picked method drives pod trends. Only methods that measure green area can.</p>
      {(primary.error ?? rerun.error) && <InlineError>{(primary.error ?? rerun.error)?.message}</InlineError>}
    </div>
  )
}

const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/**
 * One line on what the versions read over the chart against the pod's
 * record: a seeded or empty pod should stay under 2 %, a growing or
 * harvest-ready one over it on its newest photo. Nothing for a pod in need of
 * attention, or with nothing charted.
 */
export function podReading(status: PodStatus | undefined, series: Array<{ name: string, values: number[] }>): string | null {
  const charted = series.filter(s => s.values.length > 0)
  if (charted.length === 0) return null
  if (status === 'empty' || status === 'seeded') {
    const noisy = charted.filter(s => Math.max(...s.values) >= NO_PLANT)
    const quiet = charted.filter(s => !noisy.includes(s))
    if (noisy.length === 0) return `Every version holds under 2% on this ${status} pod.`
    const high = noisy.map(s => `${s.name} up to ${pct(Math.max(...s.values))}`)
    if (quiet.length === 0) return `Every version reads plant on this ${status} pod at times: ${listed(high)}.`
    return `${listed(high)} on this ${status} pod; ${listed(quiet.map(s => s.name))} ${quiet.length === 1 ? 'holds' : 'hold'} under 2%, as it should.`
  }
  if (status === 'growing' || status === 'harvest') {
    const blind = charted.filter(s => (s.values.at(-1) as number) < NO_PLANT)
    const word = status === 'growing' ? 'growing' : 'ready to harvest'
    if (blind.length === 0) return `Every version sees the plant on the newest photo of this ${word} pod.`
    return `${listed(blind.map(s => s.name))} ${blind.length === 1 ? 'reads' : 'read'} under 2% on the newest photo, though the pod is ${word}.`
  }
  return null
}

const versionOf = (name: string) => name.slice(name.lastIndexOf('@'))
const allOf = (n: number) => (n === 2 ? 'both photos' : `all ${n} photos`)

/**
 * One line on what the versions read over the chart against the grower's
 * labels for the pod, on the photos they were given on, by the same rule as
 * the agreement with labels (unhealthy pods aren't scored). Null when no
 * charted photo carries a label that says anything about green area, so the
 * pod's record can speak instead.
 */
export function labelReading(labels: Array<{ captureId: string, label: PodLabelValue }>, series: Array<{ name: string, points: Array<{ captureId: string, value: number }> }>): string | null {
  const labelOf = new Map(labels.map(l => [l.captureId, l.label]))
  const photos = new Set<string>()
  const scored = series.map((s) => {
    const by = new Map<PodLabelValue, { miss: number, total: number }>()
    for (const p of s.points) {
      const label = labelOf.get(p.captureId)
      if (!label) continue
      const ok = agrees(label, { metric: 'green_fraction', value: p.value, detail: null })
      if (ok === null) continue
      photos.add(p.captureId)
      const c = by.get(label) ?? { miss: 0, total: 0 }
      c.total += 1
      if (!ok) c.miss += 1
      by.set(label, c)
    }
    return { name: s.name, by: [...by] }
  }).filter(s => s.by.length > 0)
  if (scored.length === 0) return null
  const line = pct(AGREE_GREEN)
  if (scored.every(s => s.by.every(([, c]) => c.miss === 0))) return `Every version agrees with your labels on ${photos.size === 1 ? 'the photo' : allOf(photos.size)} you labelled.`
  const off = scored.filter(s => s.by.some(([, c]) => c.miss > 0))
  const on = scored.filter(s => !off.includes(s))
  const misses = off.map((s) => {
    const parts = s.by.filter(([, c]) => c.miss > 0).map(([label, c]) => {
      // A label that wants no plant up is missed by reading over the line, and the other way about.
      const side = agrees(label, { metric: 'green_fraction', value: 0, detail: null }) ? 'over' : 'under'
      const which = c.total === 1 ? 'the photo' : c.miss === c.total ? allOf(c.total) : `${c.miss} of ${c.total} photos`
      return `${side} ${line} on ${which} you labelled ${label}`
    })
    return `${s.name} read ${listed(parts)}`
  })
  if (on.length === 0) return `${misses.join('; ')}.`
  // Every scored version of one number agreeing reads as that number's versions.
  const v = versionOf(on[0]?.name ?? '')
  const whole = on.length > 1 && on.every(s => versionOf(s.name) === v) && off.every(s => versionOf(s.name) !== v)
  const agreeing = whole ? `the ${v} versions agree` : `${listed(on.map(s => s.name))} ${on.length === 1 ? 'agrees' : 'agree'}`
  return `${misses.join('; ')}; ${agreeing}.`
}

/** A mark on the chart where the grower's label for the pod changes, the first one included. */
export function labelMarks(labels: Array<{ ts: string, label: PodLabelValue }>): Array<{ x: number, label: string }> {
  return labels.filter((l, i) => labels[i - 1]?.label !== l.label).map(l => ({ x: Date.parse(l.ts), label: l.label }))
}

/** `n` items spread evenly from the first to the last. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))] as T)
}

/**
 * One pod across every analyser version, following the pod last picked here
 * or on Pods, with its crop from the newest photo, a strip of photos over
 * the chart's window to show why a line jumps, and the lines read against the
 * grower's labels in the window (or the pod's record with none). With no pod
 * picked, every planted pod side by side, any of which can be picked.
 */
function PodOverTime({ colorOf, slot, onSlot, pods, trends, boxes }: {
  colorOf: (k: string) => string
  slot: number
  onSlot: (slot: number) => void
  pods: Pod[]
  trends: Trend[]
  boxes: (camera: Camera) => PodRegions
}) {
  const one = slot > 0
  const cmp = trpc.vision.compare.useQuery({ slot: Math.max(1, slot), metric: 'green_fraction', limit: 200 }, { enabled: one })
  const states = trpc.vision.compare.useQuery({ slot: Math.max(1, slot), metric: 'pod_state', limit: 1 }, { enabled: one })
  // The chart's window, so only the labels it can show are read.
  const span = (cmp.data ?? []).flatMap(s => s.points.map(p => p.ts)).sort()
  const labels = trpc.vision.podLabels.useQuery({ slot: Math.max(1, slot), from: span[0], to: span.at(-1), limit: 200 }, { enabled: one && span.length > 0 })
  if (!one) return (
    <Panel>
      <span className="text-[15px] font-medium">All pods over time</span>
      <AllPods pods={pods} trends={trends} onPick={onSlot} />
    </Panel>
  )
  const pod = pods.find(p => p.slot === slot)
  const camera = cameraOf(slot)
  const box = camera ? boxes(camera)[slot] : undefined
  const data = cmp.data ?? []
  const series = data.map(s => ({ name: key(s), color: colorOf(key(s)), points: s.points.map(p => ({ x: Date.parse(p.ts), y: p.value })) }))
  // Every photo any version scored this pod on, oldest first.
  const shots = [...new Map(data.flatMap(s => s.points).map(p => [p.captureId, p.ts])).entries()]
    .map(([captureId, ts]) => ({ captureId, ts }))
    .sort((a, b) => a.ts.localeCompare(b.ts))
  const labelled = labels.data ?? []
  const reading = labelReading(labelled, data.map(s => ({ name: key(s), points: s.points })))
    ?? podReading(pod?.status, data.map(s => ({ name: key(s), values: s.points.map(p => p.value) })))
  return (
    <Panel>
      <div className="flex items-start gap-3">
        {camera && <Latest camera={camera} slot={slot} box={box} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">One pod over time</span>
          <span className="text-xs text-fg-2">{[`Pod ${slot}`, pod?.plant].filter(Boolean).join(' · ')}</span>
        </div>
        <button type="button" className="flex shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg" onClick={() => onSlot(0)}>
          <ArrowLeft size={14} />
          All pods
        </button>
      </div>
      <TimeChart series={series} height={180} yMin={0} yMax={1} formatY={pct} formatX={x => new Date(x).toLocaleDateString()} markers={labelMarks(labelled)} />
      {camera && box && shots.length > 1 && (
        <div className="grid grid-cols-5 gap-1.5" data-testid="pod-strip">
          {spread(shots, STRIP).map(s => <Shot key={s.captureId} id={s.captureId} ts={s.ts} slot={slot} box={box} />)}
        </div>
      )}
      {series.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {data.map(s => (
            <span key={key(s)} className="text-fg-2">
              {`${key(s)} `}
              <span className="font-mono text-fg">{pct(s.points.at(-1)?.value ?? 0)}</span>
            </span>
          ))}
        </div>
      )}
      {(states.data ?? []).map((s) => {
        const p = s.points.at(-1)
        return p && (
          <span key={key(s)} className="text-sm text-fg-2">
            {`${key(s)} `}
            <span className="font-mono text-fg">{POD_STATES[p.value] ?? `class ${p.value}`}</span>
            <span className="text-xs text-fg-3">{` · ${fmtStamp(p.ts)}`}</span>
          </span>
        )
      })}
      {reading && <p className="text-xs leading-normal text-fg-2 text-pretty">{reading}</p>}
    </Panel>
  )
}

/** The pod as its camera's newest photo shows it. */
function Latest({ camera, slot, box }: { camera: Camera, slot: number, box: PodRegions[number] | undefined }) {
  const frame = trpc.camera.list.useQuery({ camera, limit: 1 }).data?.[0]
  return (
    <div className="w-16 shrink-0 sm:w-20">
      <Crop src={frame && srcOf(frame.path, frame.url)} box={box} alt={frame ? `Pod ${slot} at ${frame.ts}` : `Pod ${slot}`} empty={frame ? 'No box' : 'No photo'} />
    </div>
  )
}

/** One photo of the pod from the strip, with when it was taken; a pruned one says so. */
function Shot({ id, ts, slot, box }: { id: string, ts: string, slot: number, box: PodRegions[number] }) {
  const c = trpc.camera.get.useQuery({ id }, { retry: false }).data
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <Crop src={c && srcOf(c.path, c.url)} box={box} alt={`Pod ${slot} at ${ts}`} empty="Pruned" />
      <figcaption className="flex flex-col text-center font-mono text-[10px] leading-tight text-fg-3">
        <span>{new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
        <span>{new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </figcaption>
    </figure>
  )
}

/** A pod's crop, cut from its still with CSS as the tagger does: the still scaled so the pod's box fills the tile. */
function Crop({ src, box, alt, empty }: { src: string | undefined, box: PodRegions[number] | undefined, alt: string, empty: string }) {
  // The still's shape, so the tile has the pod's: 4:3 until it loads.
  const [ratio, setRatio] = useState(4 / 3)
  return (
    <div className="relative w-full overflow-hidden rounded-[6px] bg-code" style={{ aspectRatio: box ? (box.w / box.h) * ratio : 1 }}>
      {src && box
        ? (
            <img
              src={src}
              alt={alt}
              loading="lazy"
              className="absolute max-w-none"
              style={{ width: at(1 / box.w), height: at(1 / box.h), left: at(-box.x / box.w), top: at(-box.y / box.h) }}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                if (w > 0 && h > 0) setRatio(w / h)
              }}
            />
          )
        : <span className="flex size-full items-center justify-center p-1 text-center text-[10px] text-fg-3">{empty}</span>}
    </div>
  )
}
