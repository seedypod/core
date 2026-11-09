import { Download, RefreshCw, Star } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { TimeChart } from '@/src/components/charts/TimeChart'
import { Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, SelectValue, Toggle } from '@/src/components/ds/forms'
import { SettingRow } from '@/src/components/ds/layout'
import { isDemo } from '@/src/demo/mode'
import { fmtStamp } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'
import type { Rect } from '@/src/vision/greenArea'
import { POD_STATES } from '@/src/vision/podState'
import { podRegions, type PodRegions } from '@/src/vision/regions'
import { LabelPods } from './LabelPods'
import { PodBounds } from './PodBounds'

const pct = (v: number) => `${Math.round(v * 100)}%`
const key = (a: { analyzer: string, version: number }) => `${a.analyzer}@${a.version}`
const listingKey = (a: Listing) => key({ analyzer: a.id, version: a.version })
const SLOTS = Array.from({ length: 30 }, (_, i) => ({ value: i + 1, label: `Pod ${i + 1}` }))
/** Each analyser's mark in the legend, the per-pod bars and the chart, in listing order. */
const COLORS = ['var(--meter)', 'var(--pod-ok)', 'var(--pod-ready)', 'var(--pod-attention)']
const colorAt = (i: number) => COLORS[i % COLORS.length] as string

type Listing = inferRouterOutputs<AppRouter>['vision']['analyzers'][number]
type Result = inferRouterOutputs<AppRouter>['vision']['capture'][number]
type Frame = inferRouterOutputs<AppRouter>['camera']['list'][number]
type Camera = 'upper' | 'lower'
type Shown = Camera | 'both'
type View = 'photo' | 'bounds'

const SHOWN = [{ value: 'both', label: 'Both' }, { value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }] as const
const VIEWS = [{ value: 'photo', label: 'Photo' }, { value: 'bounds', label: 'Pod bounds' }] as const
const title = (c: Camera) => (c === 'upper' ? 'Upper' : 'Lower')

function Panel({ className, children }: { className?: string, children: ReactNode }) {
  return <div className={cn('flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-5', className)}>{children}</div>
}

/** `rows` are green fractions; `states` are a learned analyser's pod states (#185). */
interface Latest { camera: Camera, frame: Frame | undefined, rows: Result[], states: Result[] }

/** One camera's newest still and every analyser's green fraction and pod state on it. */
function useLatest(camera: Camera): Latest {
  const list = trpc.camera.list.useQuery({ camera, limit: 1 })
  const frame = list.data?.[0]
  const results = trpc.vision.capture.useQuery({ captureId: frame?.id ?? '' }, { enabled: !!frame })
  const all = results.data ?? []
  return { camera, frame, rows: all.filter(r => r.metric === 'green_fraction'), states: all.filter(r => r.metric === 'pod_state') }
}

/** A pod-state row as words: `growing · 87%`. */
export function stateText(r: Pick<Result, 'value' | 'detail'>): string {
  const name = typeof r.detail?.state === 'string' ? r.detail.state : (POD_STATES[r.value] ?? `class ${r.value}`)
  return typeof r.detail?.confidence === 'number' ? `${name} · ${pct(r.detail.confidence)}` : name
}

/**
 * Capture analysis (ADR-0019): which analysers ran, which one drives pod
 * trends, and how their outputs compare on the same pods and photos, for both
 * cameras at once.
 */
export function AnalysisPage() {
  const analyzers = trpc.vision.analyzers.useQuery()
  const status = trpc.vision.status.useQuery(undefined, { refetchInterval: 5000 })
  const pods = trpc.grow.pods.useQuery()
  const [exporting, setExporting] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown>('both')
  const [view, setView] = useState<View>('photo')
  const latest = [useLatest('upper'), useLatest('lower')]
  const calibration = useCalibration()
  const st = status.data
  const list = analyzers.data ?? []
  const colorOf = (k: string) => colorAt(Math.max(0, list.findIndex(a => listingKey(a) === k)))
  // The primary analyser until one is picked.
  const selected = list.find(a => listingKey(a) === picked) ?? list.find(a => a.primary) ?? list[0]
  const cameras = shown === 'both' ? latest : latest.filter(l => l.camera === shown)
  const pod = (slot: number) => pods.data?.find(p => p.slot === slot)

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[200px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Analysis</h1>
          <p className="text-[13px] text-fg-2">How leaf cover is measured from camera frames</p>
        </div>
        <Button icon={Download} className="px-3 py-[7px]" onClick={() => setExporting(true)}>Export dataset</Button>
      </div>
      {st && (st.backfill || st.running || st.failed > 0) && (
        <p className="-mt-3 text-[13px] text-fg-2">
          {[
            st.backfill && `Re-running ${st.backfill.analyzer}: ${st.backfill.done} of ${st.backfill.total} captures`,
            st.running && !st.backfill && `Scoring ${st.running}`,
            st.failed > 0 && `${st.failed} capture${st.failed === 1 ? '' : 's'} could not be scored`,
          ].filter(Boolean).join(' · ')}
        </p>
      )}

      <Panel>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="mr-auto text-[15px] font-medium">Latest photos</span>
          {list.length > 0 && selected && (
            <SelectValue label="Analyser" value={listingKey(selected)} options={list.map(a => ({ value: listingKey(a), label: listingKey(a) }))} onChange={setPicked} />
          )}
          <SegmentedControl ariaLabel="Camera" size="sm" options={SHOWN} value={shown} onChange={setShown} />
          <SegmentedControl ariaLabel="View" size="sm" options={VIEWS} value={view} onChange={setView} />
        </div>
        <div className={cn('grid grid-cols-1 gap-3', cameras.length > 1 && 'sm:grid-cols-2')}>
          {cameras.map(l => (
            <Still
              key={l.camera}
              latest={l}
              view={view}
              analyzer={selected && listingKey(selected)}
              empty={slot => pod(slot)?.status === 'empty'}
              boxes={calibration.boxes(l.camera)}
              calibrated={calibration.calibrated(l.camera)}
              onChange={calibration.draft ? (slot, r) => calibration.move(l.camera, slot, r) : undefined}
            />
          ))}
        </div>
        {view === 'bounds' && <Calibrate c={calibration} cameras={cameras.map(l => l.camera)} />}
        {selected && <AnalyzerDetail a={selected} color={colorOf(listingKey(selected))} busy={!!st?.backfill} />}
      </Panel>

      <LabelPods boxes={calibration.boxes} />
      <PerPod analyzers={list} latest={cameras} colorOf={colorOf} plant={slot => pod(slot)?.plant ?? '—'} empty={slot => pod(slot)?.status === 'empty'} />
      <ComparePod colorOf={colorOf} />

      {exporting && (
        <Modal open onClose={() => setExporting(false)} title="Export a dataset" icon={Download}>
          <DatasetExport />
        </Modal>
      )}
    </div>
  )
}

/** One camera's still, with the pod bounds and the chosen analyser's reading per pod drawn over it on request. */
function Still({ latest, view, analyzer, empty, boxes, calibrated, onChange }: {
  latest: Latest
  view: View
  analyzer?: string
  empty: (slot: number) => boolean
  boxes: PodRegions
  calibrated: boolean
  onChange?: (slot: number, r: Rect) => void
}) {
  const { camera, frame, rows, states } = latest
  // The box takes the still's own shape once it loads, so the bounds sit where the analysers put them.
  const [ratio, setRatio] = useState(4 / 3)
  const reading = (slot: number) => {
    const state = states.find(r => r.slot === slot && key(r) === analyzer)
    if (state) return stateText(state).split(' · ')[0]
    if (empty(slot)) return undefined
    const v = rows.find(r => r.slot === slot && key(r) === analyzer)?.value
    return v === undefined ? undefined : pct(v)
  }
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <div className="relative overflow-hidden rounded-[10px] bg-code" style={{ aspectRatio: ratio }}>
        {frame
          ? (
              <img
                src={frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`}
                alt={`${camera} camera at ${frame.ts}`}
                className="absolute inset-0 size-full"
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                  if (w > 0 && h > 0) setRatio(w / h)
                }}
              />
            )
          : <div className="flex size-full items-center justify-center p-4 text-center text-[13px] text-fg-3">No photos from this camera yet.</div>}
        {frame && view === 'bounds' && <PodBounds boxes={boxes} label={reading} onChange={onChange} />}
      </div>
      <figcaption className="flex flex-wrap gap-x-2 text-xs text-fg-3">
        <span className="text-fg-2">{title(camera)}</span>
        <span>{camera === 'upper' ? 'pods 1–15' : 'pods 16–30'}</span>
        {view === 'bounds' && <span>{calibrated ? '· calibrated boxes' : '· measured boxes'}</span>}
        {frame && <span className="ml-auto font-mono text-[11px]">{fmtStamp(frame.ts)}</span>}
      </figcaption>
    </figure>
  )
}

/** The chosen analyser: what it does, how much it has scored, and making it primary or re-running it. */
function AnalyzerDetail({ a, color, busy }: { a: Listing, color: string, busy: boolean }) {
  const utils = trpc.useUtils()
  const primary = trpc.vision.setPrimary.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const rerun = trpc.vision.rerun.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const current = a.source === 'device' && a.runsOn.includes('device') && !a.disabled
  const canBePrimary = a.metrics.length === 0 || a.metrics.some(m => m.name === 'green_fraction')
  const action = 'flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45'
  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-t border-line pt-4">
      <div className="flex items-start gap-2">
        <span className="mt-[9px] h-[3px] w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">{a.label}</span>
          <span className="font-mono text-[11px] text-fg-3">{`${a.id}@${a.version} · ${a.source === 'device' ? 'on device' : 'remote'}`}</span>
        </div>
        {a.primary && <span className="rounded-[10px] bg-pod-ok/15 px-2 py-0.5 font-mono text-[10px] font-medium text-pod-ok">PRIMARY</span>}
      </div>
      <p className="text-[13px] leading-[1.55] text-fg-2 text-pretty">{a.description}</p>
      {a.disabled && <p className="rounded-[10px] bg-pod-attention/10 px-3 py-2 text-[13px] text-fg-2">{`Off. ${a.disabled}`}</p>}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex-1 font-mono text-[11px] text-fg-3" title={a.lastTs ? `last ${new Date(a.lastTs).toLocaleString()}` : undefined}>
          {a.captures > 0 ? `${a.captures} captures · ${a.rows} results` : 'No results yet'}
        </span>
        {!a.primary && canBePrimary && (
          <button type="button" className={action} disabled={primary.isPending} onClick={() => primary.mutate({ analyzer: a.id })}>
            <Star size={16} />
            Make primary
          </button>
        )}
        {current && (
          <button type="button" className={action} disabled={busy || rerun.isPending} onClick={() => rerun.mutate({ analyzer: a.id, limit: 2000 })}>
            <RefreshCw size={16} />
            Re-run
          </button>
        )}
      </div>
      {(primary.error ?? rerun.error) && <InlineError>{(primary.error ?? rerun.error)?.message}</InlineError>}
    </div>
  )
}

/** Short column head from an analyser id: `exg-otsu` → `OTSU`. */
const head = (k: string) => (k.split('@')[0]?.split('-').at(-1) ?? k).toUpperCase()

/** How the second analyser reads against the first, in percentage points, when they agree on direction. */
export function gapSummary(rows: Result[], columns: string[], labels: Record<string, string>): string | null {
  const [a, b] = columns
  if (!a || !b) return null
  const by = (col: string) => new Map(rows.filter(r => key(r) === col).map(r => [r.slot, r.value]))
  const av = by(a)
  const diffs = [...by(b)].filter(([s]) => av.has(s)).map(([s, v]) => Math.round((v - (av.get(s) as number)) * 100))
  if (!diffs.length) return null
  const lo = Math.min(...diffs)
  const hi = Math.max(...diffs)
  const span = (x: number, y: number) => (x === y ? `${x}` : `${x}–${y}`)
  const [la, lb] = [labels[a] ?? a, labels[b] ?? b]
  if (lo > 0) return `${lb} reads ${span(lo, hi)} points higher than ${la} on every pod.`
  if (hi < 0) return `${lb} reads ${span(-hi, -lo)} points lower than ${la} on every pod.`
  return `${lb} and ${la} differ by up to ${Math.max(-lo, hi)} points.`
}

/** Every pod on the cameras shown, one row each, with every analyser's reading of its camera's latest still. */
function PerPod({ analyzers, latest, colorOf, plant, empty }: { analyzers: Listing[], latest: Latest[], colorOf: (k: string) => string, plant: (slot: number) => string, empty: (slot: number) => boolean }) {
  const rows = latest.flatMap(l => l.rows)
  const stateRows = latest.flatMap(l => l.states)
  const order = analyzers.map(listingKey)
  // Listing order, so the columns and summary read in the same order as the analyser picker.
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length)
  const columns = [...new Set(rows.map(key))].sort((a, b) => rank(a) - rank(b))
  // A learned analyser's pod state, one column each, after the green fractions.
  const stateColumns = [...new Set(stateRows.map(key))].sort((a, b) => rank(a) - rank(b))
  const value = (l: Latest, slot: number, col: string) => l.rows.find(r => r.slot === slot && key(r) === col)?.value
  const stateOf = (l: Latest, slot: number, col: string) => l.states.find(r => r.slot === slot && key(r) === col)
  const labels = Object.fromEntries(analyzers.map(a => [listingKey(a), a.label]))
  const summary = gapSummary(rows, columns, labels)
  const cell = 'border-b border-grid py-[9px]'
  const th = 'border-b border-line pb-2 font-mono text-[10px] font-normal text-fg-3'
  const any = latest.some(l => l.frame)

  return (
    <Panel>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[15px] font-medium">Per pod, latest frames</span>
        {summary && <span className="text-xs text-fg-3">{summary}</span>}
      </div>
      {!any
        ? <p className="text-[13px] text-fg-2">No photos yet.</p>
        : columns.length + stateColumns.length === 0
          ? <p className="text-[13px] text-fg-2">These photos haven&apos;t been scored yet.</p>
          : (
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full table-fixed border-collapse text-left text-[13px]">
                  <thead>
                    <tr>
                      <th className={cn(th, 'w-9')}>POD</th>
                      <th className={cn(th, 'pl-3 sm:w-[30%]')}>PLANT</th>
                      <th className={cn(th, 'hidden pl-3.5 sm:table-cell')}>LEAF COVER</th>
                      {columns.map(c => <th key={c} title={c} className={cn(th, 'w-[64px] pl-2 text-right sm:w-[84px] sm:pl-3.5')}>{head(c)}</th>)}
                      {stateColumns.map(c => <th key={c} title={c} className={cn(th, 'w-[84px] pl-2 text-right sm:w-[104px] sm:pl-3.5')}>{head(c)}</th>)}
                    </tr>
                  </thead>
                  {latest.filter(l => l.rows.length + l.states.length > 0).map((l) => {
                    const slots = [...new Set([...l.rows, ...l.states].map(r => r.slot))].sort((a, b) => a - b)
                    return (
                      <tbody key={l.camera}>
                        <tr>
                          <th colSpan={columns.length + stateColumns.length + 2} scope="rowgroup" className="pb-1 pt-3 text-left font-mono text-[10px] font-normal text-fg-3">
                            {`${l.camera.toUpperCase()}${l.frame ? ` · ${fmtStamp(l.frame.ts)}` : ''}`}
                          </th>
                          {/* The leaf-cover column is hidden on a phone; a span over it would leave a ghost column there. */}
                          <th className="hidden sm:table-cell" aria-hidden />
                        </tr>
                        {slots.map((s) => {
                          const vals = columns.map(c => value(l, s, c)).filter((v): v is number => v !== undefined)
                          const lo = Math.min(...vals)
                          const hi = Math.max(...vals)
                          // A pod marked empty has no leaf cover to report, whatever the camera sees there.
                          const none = empty(s)
                          const read = none ? `Marked empty; analysers read ${vals.map(pct).join(', ')}` : undefined
                          return (
                            <tr key={s} title={read}>
                              <td className={cn(cell, 'font-mono text-xs text-fg-3')}>{s}</td>
                              <td className={cn(cell, 'max-w-0 truncate pl-3')}>{none ? <span className="text-xs text-fg-3">Empty · no cover</span> : plant(s)}</td>
                              <td className={cn(cell, 'hidden pl-3.5 sm:table-cell')}>
                                {!none && (
                                  <div className="relative h-2.5">
                                    <span className="absolute inset-x-0 top-0.5 h-1.5 rounded-[3px] bg-active" />
                                    <span className="absolute top-0.5 h-1.5 rounded-[3px] bg-line-2" style={{ left: pct(lo), width: pct(hi - lo) }} />
                                    {columns.map((c) => {
                                      const v = value(l, s, c)
                                      return v === undefined ? null : <span key={c} className="absolute top-0 h-2.5 w-0.5" style={{ left: pct(Math.min(1, v)), background: colorOf(c) }} />
                                    })}
                                  </div>
                                )}
                              </td>
                              {columns.map((c, ci) => {
                                const v = value(l, s, c)
                                return <td key={c} className={cn(cell, 'pl-2 text-right font-mono text-xs sm:pl-3.5')} style={ci > 0 && !none ? { color: colorOf(c) } : undefined}>{v === undefined || none ? '—' : pct(v)}</td>
                              })}
                              {stateColumns.map((c) => {
                                const r = stateOf(l, s, c)
                                return <td key={c} title={r ? stateText(r) : undefined} className={cn(cell, 'truncate pl-2 text-right font-mono text-xs sm:pl-3.5')} style={{ color: colorOf(c) }}>{r ? stateText(r).split(' · ')[0] : '—'}</td>
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                    )
                  })}
                </table>
              </div>
            )}
    </Panel>
  )
}

type Calibration = ReturnType<typeof useCalibration>

/**
 * The pod boxes on each camera (#143): the unit's, or a draft while they are
 * being edited. Saving sends each camera's boxes; the unit keeps only the ones
 * that moved from the measured defaults.
 */
function useCalibration() {
  const utils = trpc.useUtils()
  const saved = trpc.vision.regions.useQuery()
  const save = trpc.vision.setRegions.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const [draft, setDraft] = useState<Partial<Record<Camera, PodRegions>> | null>(null)
  const [done, setDone] = useState(false)
  const stored = (camera: Camera): PodRegions => {
    const row = saved.data?.find(r => r.camera === camera)
    return row ? Object.fromEntries(row.regions.map(({ slot, x, y, w, h }) => [slot, { x, y, w, h }])) : podRegions(camera)
  }
  const boxes = (camera: Camera) => draft?.[camera] ?? stored(camera)
  return {
    draft,
    done,
    error: save.error?.message,
    pending: save.isPending,
    boxes,
    calibrated: (camera: Camera) => saved.data?.find(r => r.camera === camera)?.calibrated ?? false,
    edit: () => {
      setDone(false)
      setDraft({ upper: stored('upper'), lower: stored('lower') })
    },
    move: (camera: Camera, slot: number, r: Rect) => setDraft(d => ({ ...d, [camera]: { ...boxes(camera), ...d?.[camera], [slot]: r } })),
    reset: (cameras: Camera[]) => setDraft(d => ({ ...d, ...Object.fromEntries(cameras.map(c => [c, podRegions(c)])) })),
    cancel: () => setDraft(null),
    save: async () => {
      if (!draft) return
      for (const [camera, regions] of Object.entries(draft) as Array<[Camera, PodRegions]>) {
        await save.mutateAsync({ camera, regions: Object.entries(regions).map(([slot, r]) => ({ slot: Number(slot), ...r })) })
      }
      setDraft(null)
      setDone(true)
    },
  }
}

/** Editing the boxes: how, and saving, resetting or dropping the changes. */
function Calibrate({ c, cameras }: { c: Calibration, cameras: Camera[] }) {
  const action = 'cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45'
  return (
    <div className="-mt-1 flex flex-col gap-2 text-xs text-fg-3">
      <p>
        {c.draft
          ? 'Drag a box onto its pod\'s cup and its corner to fit the plant. Arrow keys move the focused box; Shift with them resizes it.'
          : 'Each pod counts plant inside its box that grows from it: centred in the box, or reaching the dashed middle.'}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {c.draft
          ? (
              <>
                <Button size="sm" disabled={c.pending} onClick={() => void c.save().catch(() => {})}>Save boxes</Button>
                <button type="button" className={action} onClick={() => c.reset(cameras)}>Reset to measured</button>
                <button type="button" className={action} onClick={c.cancel}>Cancel</button>
              </>
            )
          : <button type="button" className={action} onClick={c.edit}>Edit boxes</button>}
        {c.done && !c.draft && <span>Saved. New photos use these boxes; Re-run an analyser to rescore stored ones.</span>}
      </div>
      {c.error && <InlineError>{c.error}</InlineError>}
    </div>
  )
}

function ComparePod({ colorOf }: { colorOf: (k: string) => string }) {
  const [slot, setSlot] = useState(1)
  const cmp = trpc.vision.compare.useQuery({ slot, metric: 'green_fraction', limit: 200 })
  const states = trpc.vision.compare.useQuery({ slot, metric: 'pod_state', limit: 1 })
  const series = (cmp.data ?? []).map(s => ({ name: key(s), color: colorOf(key(s)), points: s.points.map(p => ({ x: Date.parse(p.ts), y: p.value })) }))
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[15px] font-medium">One pod over time</span>
        <SelectValue label="Pod" value={slot} options={SLOTS} onChange={setSlot} />
      </div>
      <TimeChart series={series} height={180} yMin={0} yMax={1} formatY={pct} formatX={x => new Date(x).toLocaleDateString()} />
      {series.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {cmp.data?.map(s => (
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
    </Panel>
  )
}

const WINDOWS = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const
const mb = (b: number) => `${(b / 1_000_000).toFixed(b < 10_000_000 ? 1 : 0)} MB`

/** Export the photos, results, pods and telemetry for off-device analysis or training (ADR-0019 phase 2). */
function DatasetExport() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [images, setImages] = useState(true)
  const [to] = useState(() => new Date())
  const from = new Date(to.getTime() - Number(days) * 86_400_000).toISOString()
  const summary = trpc.datasets.summary.useQuery({ from, to: to.toISOString(), images })
  const s = summary.data
  const href = `${apiBase()}/api/datasets/export?${new URLSearchParams({ from, to: to.toISOString(), images: images ? '1' : '0' }).toString()}`
  return (
    <div className="flex flex-col">
      <p className="text-[13px] text-fg-2">Photos, every analyser&apos;s results, your pod labels, pods and sensor history as a tar.</p>
      <SettingRow label="Window"><SegmentedControl ariaLabel="Window" size="sm" options={WINDOWS} value={days} onChange={setDays} /></SettingRow>
      <SettingRow label="Include photos" sub="The bulk of the size" divider={false}><Toggle label="Include photos" on={images} onChange={setImages} /></SettingRow>
      {s && <p className="mt-2 font-mono text-[12px] text-fg-3">{`${s.captures} photos · ${s.analyses} results · ${s.labels} labels · ${s.telemetry} readings${images ? ` · about ${mb(s.imageBytes)}` : ''}`}</p>}
      <div className="mt-3">
        {isDemo()
          ? <p className="text-[13px] text-fg-2">Downloads need a real unit; the demo has no server.</p>
          : <a href={href} download className="inline-flex"><Button size="sm" icon={Download} tabIndex={-1}>Download</Button></a>}
      </div>
    </div>
  )
}
