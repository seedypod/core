import { Download } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, Toggle } from '@/src/components/ds/forms'
import { SettingRow } from '@/src/components/ds/layout'
import { isDemo } from '@/src/demo/mode'
import { fmtStamp } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'
import type { Rect } from '@/src/vision/greenArea'
import { POD_STATES } from '@/src/vision/podState'
import { cameraSlots, podRegions, type PodRegions } from '@/src/vision/regions'
import { LabelPods } from './LabelPods'
import { LeafCover } from './LeafCover'
import { MethodsTab } from './MethodsTab'
import { PodBounds } from './PodBounds'
import { PodCard, PodHits, stateGuess, type Pod, type Reading, type Trend } from './PodCard'
import { teachSummary, useTeachQueue } from './TeachQueue'

const pct = (v: number) => `${Math.round(v * 100)}%`
const key = (a: { analyzer: string, version: number }) => `${a.analyzer}@${a.version}`
const listingKey = (a: Listing) => key({ analyzer: a.id, version: a.version })
/** Each analyser's mark in the legend, the per-pod bars and the chart, in listing order. */
const COLORS = ['var(--meter)', 'var(--pod-ok)', 'var(--pod-ready)', 'var(--pod-attention)']
const colorAt = (i: number) => COLORS[i % COLORS.length] as string

type Listing = inferRouterOutputs<AppRouter>['vision']['analyzers'][number]
type Result = inferRouterOutputs<AppRouter>['vision']['capture'][number]
type Frame = inferRouterOutputs<AppRouter>['camera']['list'][number]
type Camera = 'upper' | 'lower'
type Shown = Camera | 'both'
type View = 'photo' | 'bounds'
export type AnalysisTab = 'pods' | 'teach' | 'methods'

const SHOWN = [{ value: 'both', label: 'Both' }, { value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }] as const
const VIEWS = [{ value: 'photo', label: 'Photo' }, { value: 'towers', label: 'Towers' }] as const
const TABS = [{ value: 'pods', label: 'Pods' }, { value: 'teach', label: 'Teach' }, { value: 'methods', label: 'Methods' }] as const
export const isAnalysisTab = (v: unknown): v is AnalysisTab => TABS.some(t => t.value === v)
const title = (c: Camera) => (c === 'upper' ? 'Upper' : 'Lower')

function Panel({ id, className, children }: { id?: string, className?: string, children: ReactNode }) {
  return <div id={id} className={cn('flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-5', className)}>{children}</div>
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
 * Capture analysis (ADR-0019), split by job: Pods is what the photos say
 * about each pod, Teach is the labels and boxes that need the grower, and
 * Methods is which analyser drives pod trends and how they compare over time.
 */
export function AnalysisPage({ tab: asked }: { tab?: AnalysisTab } = {}) {
  const analyzers = trpc.vision.analyzers.useQuery()
  const status = trpc.vision.status.useQuery(undefined, { refetchInterval: 5000 })
  const pods = trpc.grow.pods.useQuery()
  const trends = trpc.vision.podTrends.useQuery()
  const [tab, setTab] = useState<AnalysisTab>(asked ?? 'pods')
  const [exporting, setExporting] = useState(false)
  const [shown, setShown] = useState<Shown>('both')
  const [view, setView] = useState<'photo' | 'towers'>('photo')
  // The pod picked on a photo: its card stays open and the Methods chart follows it.
  const [pinned, setPinned] = useState<number | null>(null)
  const [slot, setSlot] = useState(0)
  const latest = [useLatest('upper'), useLatest('lower')]
  const calibration = useCalibration()
  const queue = useTeachQueue({ upper: latest[0]?.frame, lower: latest[1]?.frame }, calibration.boxes)
  const labelStats = trpc.vision.labelStats.useQuery()
  // A link to another tab while the page is open switches to it.
  const [lastAsked, setLastAsked] = useState(asked)
  if (asked !== lastAsked) {
    setLastAsked(asked)
    if (asked) setTab(asked)
  }
  const st = status.data
  const list = analyzers.data ?? []
  const colorOf = (k: string) => colorAt(Math.max(0, list.findIndex(a => listingKey(a) === k)))
  const primary = list.find(a => a.primary) ?? list[0]
  const cameras = shown === 'both' ? latest : latest.filter(l => l.camera === shown)
  const pod = (slot: number) => pods.data?.find(p => p.slot === slot)
  const still = (l: Latest, v: 'photo' | 'bounds') => (
    <Still
      key={l.camera}
      latest={l}
      view={v}
      analyzer={primary && listingKey(primary)}
      empty={slot => pod(slot)?.status === 'empty'}
      pod={pod}
      trend={s => trends.data?.find(t => t.slot === s)}
      analyzers={list}
      colorOf={colorOf}
      pinned={pinned}
      onPick={(s) => {
        setPinned(p => (p === s ? null : s))
        setSlot(s)
      }}
      onUnpin={() => setPinned(null)}
      boxes={calibration.boxes(l.camera)}
      calibrated={calibration.calibrated(l.camera)}
      onChange={v === 'bounds' && calibration.draft ? (slot, r) => calibration.move(l.camera, slot, r) : undefined}
      onRemove={v === 'bounds' && calibration.draft ? slot => calibration.remove(l.camera, slot) : undefined}
    />
  )
  const stills = (v: 'photo' | 'bounds') => (
    <div className={cn('grid grid-cols-1 gap-3', cameras.length > 1 && 'sm:grid-cols-2')}>
      {cameras.map(l => still(l, v))}
    </div>
  )
  const cameraPicker = <SegmentedControl ariaLabel="Camera" size="sm" options={SHOWN} value={shown} onChange={setShown} />

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[200px] flex-1 flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold">Analysis</h1>
            {tab === 'teach' && labelStats.data
              ? (
                  // How the labels were saved stays a hover away; the subtitle is how often the suggestions were right.
                  <p className="text-[13px] text-fg-2" title={`${labelStats.data.sources.picked} picked · ${labelStats.data.sources.accepted} accepted · ${labelStats.data.sources.corrected} corrected`} data-testid="teach-summary">
                    {teachSummary(labelStats.data)}
                  </p>
                )
              : <p className="text-[13px] text-fg-2">How leaf cover is measured from camera frames</p>}
          </div>
          <Tabs value={tab} onChange={setTab} waiting={queue.total} />
        </div>
        {tab === 'teach' && <Button icon={Download} className="px-3 py-[7px]" onClick={() => setExporting(true)}>Export dataset</Button>}
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

      {tab === 'pods' && (
        <div role="tabpanel" id="analysis-pods" aria-labelledby="analysis-tab-pods" className="flex flex-col gap-6">
          <Panel id="latest-photos">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="mr-auto text-[15px] font-medium">Latest photos</span>
              {view === 'photo' && cameraPicker}
              <SegmentedControl ariaLabel="View" size="sm" options={VIEWS} value={view} onChange={setView} />
            </div>
            {view === 'photo' && stills('photo')}
          </Panel>
          {view === 'towers' && <LeafCover capturedAt={latest.map(l => l.frame?.ts).filter((t): t is string => !!t).sort().at(-1) ?? null} />}
        </div>
      )}

      {tab === 'teach' && (
        <div role="tabpanel" id="analysis-teach" aria-labelledby="analysis-tab-teach" className="flex flex-col gap-6">
          <LabelPods
            boxes={calibration.boxes}
            boxesOff={queue.boxes}
            onEditBoxes={() => {
              if (!calibration.draft) calibration.edit()
              document.getElementById('pod-bounds')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
            }}
          />
          <Panel id="pod-bounds">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="mr-auto text-[15px] font-medium">Pod bounds</span>
              {cameraPicker}
            </div>
            {stills('bounds')}
            <Calibrate c={calibration} cameras={cameras.map(l => l.camera)} />
          </Panel>
        </div>
      )}

      {tab === 'methods' && (
        <div role="tabpanel" id="analysis-methods" aria-labelledby="analysis-tab-methods" className="flex flex-col gap-6">
          <MethodsTab analyzers={list} colorOf={colorOf} busy={!!st?.backfill} slot={slot} onSlot={setSlot} pods={pods.data ?? []} trends={trends.data ?? []} boxes={calibration.boxes} />
        </div>
      )}

      {exporting && (
        <Modal open onClose={() => setExporting(false)} title="Export a dataset" icon={Download}>
          <DatasetExport />
        </Modal>
      )}
    </div>
  )
}

/** Pods, Teach and Methods, as underlined tabs over the page; Teach counts what waits on the grower. */
function Tabs({ value, onChange, waiting }: { value: AnalysisTab, onChange: (t: AnalysisTab) => void, waiting: number }) {
  return (
    <div role="tablist" aria-label="Analysis sections" className="flex gap-[22px] text-sm">
      {TABS.map(t => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={`analysis-tab-${t.value}`}
          aria-selected={value === t.value}
          aria-controls={`analysis-${t.value}`}
          className={cn('-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-0 pb-1.5 pt-0', value === t.value ? 'border-fg text-fg' : 'border-transparent text-fg-3 hover:text-fg')}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.value === 'teach' && waiting > 0 && (
            <>
              <span aria-hidden data-testid="teach-count" className={cn('ml-1 rounded-lg px-1.5 py-px font-mono text-[10px] font-medium', value === t.value ? 'bg-fg text-inverse' : 'bg-active text-fg')}>{waiting}</span>
              <span className="sr-only">{`, ${waiting} waiting`}</span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}

/**
 * One camera's still, with the pod bounds and the chosen analyser's reading
 * per pod drawn over it on request, and a card of everything known about a
 * pod when it is hovered or picked.
 */
function Still({ latest, view, analyzer, empty, pod, trend, analyzers, colorOf, pinned, onPick, onUnpin, boxes, calibrated, onChange, onRemove }: {
  latest: Latest
  view: View
  analyzer?: string
  empty: (slot: number) => boolean
  pod: (slot: number) => Pod | undefined
  trend: (slot: number) => Trend | undefined
  analyzers: Listing[]
  colorOf: (k: string) => string
  pinned: number | null
  onPick: (slot: number) => void
  onUnpin: () => void
  boxes: PodRegions
  calibrated: boolean
  onChange?: (slot: number, r: Rect) => void
  onRemove?: (slot: number) => void
}) {
  const { camera, frame, rows, states } = latest
  // The box takes the still's own shape once it loads, so the bounds sit where the analysers put them.
  const [ratio, setRatio] = useState(4 / 3)
  const [hovered, setHovered] = useState<number | null>(null)
  const shown = onChange ? null : hovered ?? pinned
  const box = shown === null ? undefined : boxes[shown]
  const order = analyzers.map(listingKey)
  const labels = Object.fromEntries(analyzers.map(a => [listingKey(a), a.label]))
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length)
  const readings = (slot: number): Reading[] => [...rows, ...states]
    .filter(r => r.slot === slot)
    .sort((a, b) => rank(key(a)) - rank(key(b)))
    .map(r => ({ key: key(r), label: labels[key(r)] ?? key(r), color: colorOf(key(r)), text: r.metric === 'pod_state' ? stateGuess(r) : pct(r.value) }))
  const reading = (slot: number) => {
    const state = states.find(r => r.slot === slot && key(r) === analyzer)
    if (state) return stateText(state).split(' · ')[0]
    if (empty(slot)) return undefined
    const v = rows.find(r => r.slot === slot && key(r) === analyzer)?.value
    return v === undefined ? undefined : pct(v)
  }
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      {/* Not clipped, so a pod's card can reach past the photo's edge. */}
      <div className="relative rounded-[10px] bg-code" style={{ aspectRatio: ratio }}>
        {frame
          ? (
              <img
                src={frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`}
                alt={`${camera} camera at ${frame.ts}`}
                className="absolute inset-0 size-full rounded-[10px]"
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                  if (w > 0 && h > 0) setRatio(w / h)
                }}
              />
            )
          : <div className="flex size-full items-center justify-center p-4 text-center text-[13px] text-fg-3">No photos from this camera yet.</div>}
        {frame && view === 'bounds' && <PodBounds boxes={boxes} label={reading} onChange={onChange} onRemove={onRemove} />}
        {frame && !onChange && <PodHits boxes={boxes} shown={shown} onHover={setHovered} onPick={onPick} />}
        {frame && shown !== null && box && (
          <PodCard slot={shown} box={box} pod={pod(shown)} trend={trend(shown)} readings={readings(shown)} pinned={shown === pinned} onClose={onUnpin} />
        )}
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

type Calibration = ReturnType<typeof useCalibration>

/**
 * The pod boxes on each camera (#143): the unit's, or a draft while they are
 * being edited. Saving sends each camera's boxes and the ones removed; the
 * unit keeps only the ones that moved from the measured defaults, and the
 * removals.
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
  const removed = (camera: Camera, regions = boxes(camera)) => cameraSlots(camera).filter(s => !regions[s])
  return {
    draft,
    done,
    error: save.error?.message,
    pending: save.isPending,
    boxes,
    removed,
    calibrated: (camera: Camera) => saved.data?.find(r => r.camera === camera)?.calibrated ?? false,
    edit: () => {
      setDone(false)
      setDraft({ upper: stored('upper'), lower: stored('lower') })
    },
    move: (camera: Camera, slot: number, r: Rect) => setDraft(d => ({ ...d, [camera]: { ...boxes(camera), ...d?.[camera], [slot]: r } })),
    remove: (camera: Camera, slot: number) => setDraft(d => ({ ...d, [camera]: Object.fromEntries(Object.entries(d?.[camera] ?? boxes(camera)).filter(([s]) => Number(s) !== slot)) })),
    restore: (camera: Camera, slot: number) => setDraft(d => ({ ...d, [camera]: { ...(d?.[camera] ?? boxes(camera)), [slot]: podRegions(camera)[slot] as Rect } })),
    reset: (cameras: Camera[]) => setDraft(d => ({ ...d, ...Object.fromEntries(cameras.map(c => [c, podRegions(c)])) })),
    cancel: () => setDraft(null),
    save: async () => {
      if (!draft) return
      for (const [camera, regions] of Object.entries(draft) as Array<[Camera, PodRegions]>) {
        await save.mutateAsync({ camera, regions: Object.entries(regions).map(([slot, r]) => ({ slot: Number(slot), ...r })), removed: removed(camera, regions) })
      }
      setDraft(null)
      setDone(true)
    },
  }
}

/** Editing the boxes: how, and saving, resetting or dropping the changes. */
function Calibrate({ c, cameras }: { c: Calibration, cameras: Camera[] }) {
  const action = 'cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45'
  const gone = cameras.flatMap(camera => c.removed(camera).map(slot => ({ camera, slot })))
  return (
    <div className="-mt-1 flex flex-col gap-2 text-xs text-fg-3">
      <p>
        {c.draft
          ? 'Drag a box onto its pod\'s cup and its corner to fit the plant. Arrow keys move the focused box; Shift with them resizes it. Remove a box (× or Delete) where this camera can\'t see its pod.'
          : 'Each pod counts plant inside its box that grows from it: centred in the box, or reaching the dashed middle.'}
      </p>
      {gone.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{`No box, not scored: ${gone.map(g => g.slot).join(', ')}`}</span>
          {c.draft && gone.map(g => (
            <button key={g.slot} type="button" className={action} onClick={() => c.restore(g.camera, g.slot)}>{`Put back ${g.slot}`}</button>
          ))}
        </div>
      )}
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
