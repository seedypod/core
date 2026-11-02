import { Link } from '@tanstack/react-router'
import { Box, Camera, ChevronDown, LayoutGrid, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/src/components/ds/core'
import { SegmentedControl, TextField } from '@/src/components/ds/forms'
import { cn } from '@/lib/utils'
import { apiBase, trpc } from '@/src/utils/trpc'
import { LineChart } from '@/src/components/ds/charts'
import { defaultPodRects } from '@/src/vision/greenArea'
import { CATALOG } from './plants/catalog'
import { PlantModel } from './PlantModel'
import { PlantThumb, podForm } from './PlantThumb'
import { ageDays, heldFor, podShown, SHOWN_LABEL, SHOWN_TOKEN, towerShape, type PodShown } from './towerLayout'
import type { PodState } from './towerScene'
import { TowerView } from './TowerView'

type Stage = 'germination' | 'seedling' | 'vegetative' | 'harvest'
type PodStatus = 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention'
const STAGES: { value: Stage, label: string }[] = [{ value: 'germination', label: 'germination' }, { value: 'seedling', label: 'seedling' }, { value: 'vegetative', label: 'vegetative' }, { value: 'harvest', label: 'harvest' }]
const STATUS: { value: PodStatus, label: string }[] = [{ value: 'empty', label: 'Empty' }, { value: 'seeded', label: 'Seeded' }, { value: 'growing', label: 'Growing' }, { value: 'harvest', label: 'Harvest' }, { value: 'attention', label: 'Attention' }]
const TREND: Record<string, string> = { growing: 'Growing', stalled: 'Stalled', declining: 'Shrinking' }
type View = 'pods' | 'tower'
const VIEW_KEY = 'seedypod.growView'
const VIEWS: { value: View, label: ReactNode }[] = [
  { value: 'pods', label: [<LayoutGrid key="i" size={16} aria-hidden="true" />, 'Pods'] },
  { value: 'tower', label: [<Box key="i" size={16} aria-hidden="true" />, 'Tower'] },
]
const PLANTS = [...new Set(CATALOG.map(e => e.name))].sort()

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tower' ? 'tower' : 'pods'
  }
  catch {
    return 'pods'
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`
/** "12 Oct"; a bare date ("2026-10-12") is read as that day wherever the browser is. */
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', ...(iso.length === 10 ? { timeZone: 'UTC' } : null) })
const towerName = (i: number) => String.fromCharCode(65 + i)

/** The pods down each of the tower's columns: A holds 1–10 on a Home's three, 1–8 on a Studio's two. */
function towersOf<T extends { slot: number }>(pods: T[]): T[][] {
  if (pods.length === 0) return []
  const n = towerShape(pods.length).columns
  const per = Math.ceil(pods.length / n)
  return Array.from({ length: n }, (_, i) => pods.slice(i * per, (i + 1) * per)).filter(t => t.length > 0)
}

/** Which camera sees a pod, and where in its frame: the crop the analyser scores. */
function podCrop(slot: number) {
  for (const camera of ['upper', 'lower'] as const) {
    const rect = defaultPodRects(camera, 1, 1)[slot]
    if (rect) return { camera, rect }
  }
  return null
}

const ROW_CLASS: Record<PodShown, string> = {
  attention: 'bg-surface border-pod-attention/50',
  ready: 'bg-surface border-pod-ready/30',
  soon: 'bg-surface border-line',
  growing: 'bg-surface border-line',
  seeded: 'bg-surface border-line',
  empty: 'bg-transparent border-line/60',
}

interface Draft { slot: number, plant: string, status: PodStatus, notes: string }

/**
 * Pods (three tower columns of rows) or the 3D tower on the left, the picked
 * pod down the right; on a phone the panel drops below.
 */
export function GrowPage() {
  const utils = trpc.useUtils()
  const grow = trpc.grow.current.useQuery()
  const pods = trpc.grow.pods.useQuery()
  const harvest = trpc.grow.harvest.useQuery()
  const settings = trpc.settings.get.useQuery()
  const start = trpc.grow.start.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const end = trpc.grow.end.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const setStage = trpc.grow.setStage.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const updatePod = trpc.grow.updatePod.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const markHarvested = trpc.grow.markHarvested.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const trends = trpc.vision.podTrends.useQuery()
  const sensors = trpc.sensors.latest.useQuery()
  const light = trpc.light.get.useQuery()
  // `?pod=N` (from Home, the sidebar and search) opens that pod until another is picked.
  const [selected, setSelected] = useState<number | null>(() => {
    const n = Number(new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('pod'))
    return Number.isInteger(n) && n > 0 ? n : null
  })
  const [edited, setDraft] = useState<Draft | null>(null)
  const [name, setName] = useState('')
  const [view, setView] = useState<View>(savedView)
  const [noWebGL, setNoWebGL] = useState(false)
  const chooseView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    }
    catch {
      // private window: the choice lasts for this visit
    }
  }
  const all = [...(pods.data ?? [])].sort((a, b) => a.slot - b.slot)
  const trendBySlot = new Map((trends.data ?? []).map(t => [t.slot, t]))
  const outlook = new Map((harvest.data ?? []).map(h => [h.slot, h]))
  const towerPods: PodState[] = all.map((p) => {
    const t = trendBySlot.get(p.slot)
    return { slot: p.slot, status: p.status, plant: p.plant, green: t?.green ?? null, verdict: t?.verdict, recent: t?.recent, notes: p.notes, ageDays: ageDays(p.plantedAt), statusSince: p.statusSince, harvest: outlook.get(p.slot) ?? null }
  })
  const towers = towersOf(towerPods)
  const shownOf = new Map(towerPods.map(p => [p.slot, podShown(p)]))
  const select = (slot: number) => {
    setSelected(slot)
    setDraft(null)
  }
  const saved = selected === null ? undefined : all.find(p => p.slot === selected)
  const draft: Draft | null = edited ?? (saved ? { slot: saved.slot, plant: saved.plant ?? '', status: saved.status, notes: saved.notes } : null)
  const dirty = !!draft && !!saved && (draft.plant !== (saved.plant ?? '') || draft.status !== saved.status || draft.notes !== saved.notes)
  const shown: View = noWebGL ? 'pods' : view
  const cycle = grow.data?.cycle
  const length = settings.data?.harvestReminderDays ?? 0
  const count = (s: PodShown) => towerPods.filter(p => shownOf.get(p.slot) === s).length
  const counts = [
    { label: 'growing', n: towerPods.length - count('ready') - count('attention') - count('empty'), token: SHOWN_TOKEN.growing },
    { label: 'ready', n: count('ready'), token: SHOWN_TOKEN.ready },
    { label: 'attention', n: count('attention'), token: SHOWN_TOKEN.attention },
    { label: 'empty', n: count('empty'), token: SHOWN_TOKEN.empty },
  ]

  return (
    <div className="flex flex-col gap-5 min-[900px]:pt-3">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Grow</h1>
          <div className="text-[13px] text-fg-2">{cycle ? [cycle.notes, `started ${shortDate(cycle.startedAt)}`].filter(Boolean).join(' · ') : 'No active cycle'}</div>
        </div>
        {!noWebGL && (
          <SegmentedControl<View>
            ariaLabel="Pod view"
            value={shown}
            options={VIEWS}
            onChange={chooseView}
          />
        )}
        {cycle && <Button onClick={() => end.mutate()}>End cycle</Button>}
      </div>

      <section aria-label="Cycle" className="flex flex-wrap items-center gap-7 rounded-[14px] border border-line bg-surface px-5 py-[18px]">
        {cycle
          ? (
              <>
                <div className="flex items-baseline gap-2">
                  <div className="font-mono text-[28px] font-medium leading-none">{`Day ${grow.data?.day}`}</div>
                  {length > 0 && <div className="font-mono text-xs text-fg-3">{`of ~${length}`}</div>}
                </div>
                {cycle.stage !== 'ended' && <StageBar stage={cycle.stage} onChange={stage => setStage.mutate({ stage })} />}
                <div data-testid="pod-counts" className="flex flex-wrap gap-4 font-mono text-xs text-fg-2">
                  {counts.map(c => (
                    <span key={c.label} className="flex items-center gap-1.5">
                      <span className="size-[7px] rounded-full" style={{ background: c.token }} />
                      {`${c.n} ${c.label}`}
                    </span>
                  ))}
                </div>
              </>
            )
          : (
              <>
                <div className="flex min-w-[240px] flex-1 flex-col gap-1">
                  <div className="text-[15px] font-medium">No active cycle</div>
                  <div className="text-[13px] text-fg-2">Start a cycle to get thinning, root-check, harvest and nutrient reminders.</div>
                </div>
                <TextField label="Cycle name" mono={false} value={name} onChange={setName} placeholder="e.g. Autumn greens" className="w-56" />
                <Button variant="primary" className="self-end" onClick={() => start.mutate({ notes: name.trim() })}>Start cycle</Button>
              </>
            )}
      </section>

      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-0 flex-1 basis-[480px]">
          {shown === 'tower' && (
            <TowerView
              pods={towerPods}
              waterPct={sensors.data?.water_level_pct?.value ?? null}
              lightLevel={light.data?.on ? light.data.level : 0}
              selected={selected}
              onSelect={select}
              onUnavailable={() => setNoWebGL(true)}
            />
          )}
          {noWebGL && <p className="mb-2 text-xs text-fg-3">The 3D tower needs WebGL, which this browser doesn&apos;t offer, so the pods are shown as a list.</p>}
          {shown === 'pods' && (
            <div className="flex flex-col gap-2.5 min-[640px]:flex-row" aria-label="Pods">
              {towers.map((tower, i) => (
                <div key={towerName(i)} className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="mb-1 px-0.5 font-mono text-[10px] font-medium tracking-[0.1em] text-fg-3">
                    {`TOWER ${towerName(i)} · PODS ${tower[0]?.slot}–${tower.at(-1)?.slot}`}
                  </div>
                  {tower.map((p) => {
                    const s = shownOf.get(p.slot) ?? 'empty'
                    const cover = p.harvest?.cover ?? p.green ?? null
                    const picked = selected === p.slot
                    return (
                      <button
                        key={p.slot}
                        type="button"
                        onClick={() => select(p.slot)}
                        aria-pressed={picked}
                        aria-label={`${p.slot} ${p.plant ?? 'empty'}`}
                        className={cn('flex min-h-[44px] items-center gap-2.5 rounded-[9px] border px-2.5 py-[9px] text-left transition-colors hover:border-pod-empty', picked ? 'border-fg-2 bg-active' : ROW_CLASS[s])}
                      >
                        <span className="w-4 font-mono text-[10px] text-fg-3">{p.slot}</span>
                        <span className="size-[7px] shrink-0 rounded-full" style={{ background: s === 'empty' ? 'var(--border-2)' : SHOWN_TOKEN[s] }} />
                        <PlantThumb plant={p.plant} stage={podForm(p)} size={32} />
                        <span className={cn('min-w-0 flex-1 truncate text-[13px]', s === 'empty' ? 'text-pod-empty' : 'text-fg')}>{p.plant ?? (s === 'empty' ? 'Empty · plant' : '')}</span>
                        {s !== 'empty' && cover !== null && <span className="font-mono text-[11px] text-fg-3">{pct(cover)}</span>}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <aside
          aria-label={draft ? `Pod ${draft.slot}` : 'Selected pod'}
          className="flex w-full shrink-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-[18px] min-[900px]:sticky min-[900px]:top-7 min-[900px]:w-[300px]"
        >
          {draft && saved
            ? (
                <PodPanel
                  pod={towerPods.find(p => p.slot === draft.slot) ?? { slot: draft.slot, status: saved.status, plant: saved.plant }}
                  tower={towerName(Math.max(0, towers.findIndex(t => t.some(p => p.slot === draft.slot))))}
                  coverPerDay={outlook.get(draft.slot)?.coverPerDay ?? null}
                  plantedAt={saved.plantedAt}
                  draft={draft}
                  dirty={dirty}
                  saving={updatePod.isPending}
                  onChange={setDraft}
                  onClose={() => {
                    setSelected(null)
                    setDraft(null)
                  }}
                  onSave={() => updatePod.mutate({ slot: draft.slot, plant: draft.plant.trim() || null, status: draft.status, notes: draft.notes, plantedAt: draft.status === 'seeded' && saved.status !== 'seeded' ? new Date().toISOString().slice(0, 10) : undefined }, { onSuccess: () => setDraft(null) })}
                  onRevert={() => setDraft(null)}
                  onHarvested={() => markHarvested.mutate({ slot: draft.slot })}
                  onDismiss={() => updatePod.mutate({ slot: draft.slot, status: 'growing' }, { onSuccess: () => setDraft(null) })}
                />
              )
            : (
                <div className="flex flex-col gap-1">
                  <div className="text-[15px] font-medium">Pods</div>
                  <p className="text-[13px] text-fg-2">{`Click a pod ${shown === 'tower' ? 'on the tower' : 'in the list'} to see and edit it.`}</p>
                </div>
              )}
        </aside>
      </div>
    </div>
  )
}

/** The cycle's stages left to right, filled up to today's; today's label picks the stage. */
function StageBar({ stage, onChange }: { stage: string, onChange: (stage: Stage) => void }) {
  const at = STAGES.findIndex(s => s.value === stage)
  return (
    <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
      <div className="flex h-1.5 gap-[3px]">
        {STAGES.map((s, i) => <div key={s.value} className={cn('flex-1 rounded-[3px]', i <= at ? 'bg-meter' : 'bg-line')} />)}
      </div>
      <div className="flex font-mono text-[10px] text-fg-3">
        {STAGES.map((s, i) => i === at
          ? (
              <span key={s.value} className="relative flex flex-1 items-center">
                <select
                  aria-label="Stage"
                  value={s.value}
                  onChange={e => onChange(e.target.value as Stage)}
                  className="cursor-pointer appearance-none bg-transparent pr-3 font-mono text-[10px] text-fg outline-none [field-sizing:content]"
                >
                  {STAGES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={10} className="pointer-events-none -ml-2.5 text-fg" />
              </span>
            )
          : <span key={s.value} className="flex-1">{s.label}</span>)}
      </div>
    </div>
  )
}

/** The latest still from the camera that sees `slot`, cut to that pod's crop. */
function PodCrop({ slot }: { slot: number }) {
  const crop = podCrop(slot)
  const list = trpc.camera.list.useQuery({ camera: crop?.camera ?? 'upper', limit: 1 }, { enabled: crop !== null })
  const [aspect, setAspect] = useState<number | null>(null)
  if (!crop) return null
  const frame = list.data?.[0]
  const src = frame ? (frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`) : null
  const { rect } = crop
  const ago = heldFor(frame?.ts)
  return (
    <div className="relative overflow-hidden rounded-[10px] bg-app" style={{ aspectRatio: aspect ?? 2 }} data-aspect={aspect ?? undefined}>
      {src
        ? (
            <img
              src={src}
              alt={`Pod ${slot} on the ${crop.camera} camera`}
              className="absolute left-0 top-0 max-w-none"
              style={{ width: `${100 / rect.w}%`, transform: `translate(-${rect.x * 100}%, -${rect.y * 100}%)` }}
              onLoad={(e) => {
                // The drawn size, not the natural one: an SVG still without a width reports 300×150.
                const { offsetWidth: w, offsetHeight: h } = e.currentTarget
                if (w > 0 && h > 0) setAspect((rect.w * w) / (rect.h * h))
              }}
            />
          )
        : <div className="flex h-full items-center justify-center font-mono text-[11px] text-pod-empty">{`no photo yet · ${crop.camera} camera`}</div>}
      {src && <span className="absolute bottom-1.5 left-2 rounded bg-app/70 px-1.5 py-0.5 font-mono text-[10px] text-fg-3">{`${crop.camera} camera${ago ? ` · ${ago === 'now' ? 'just now' : `${ago} ago`}` : ''}`}</span>}
    </div>
  )
}

function Row({ label, children, last }: { label: string, children: ReactNode, last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 py-2.5 text-[13px]', !last && 'border-b border-line/70')}>
      <span className="shrink-0 text-fg-2">{label}</span>
      {children}
    </div>
  )
}

const INLINE = 'min-w-0 flex-1 bg-transparent text-right text-fg outline-none placeholder:text-fg-3'

function PodPanel({ pod, tower, coverPerDay, plantedAt, draft, dirty, saving, onChange, onClose, onSave, onRevert, onHarvested, onDismiss }: {
  pod: PodState
  tower: string
  /** Leaf cover gained a day, from the harvest outlook. */
  coverPerDay: number | null
  plantedAt: string | null
  draft: Draft
  dirty: boolean
  saving: boolean
  onChange: (d: Draft) => void
  onClose: () => void
  onSave: () => void
  onRevert: () => void
  onHarvested: () => void
  onDismiss: () => void
}) {
  const shown = podShown(pod)
  const form = podForm(pod)
  const h = pod.harvest ?? null
  const cover = h?.cover ?? pod.green ?? null
  const since = heldFor(pod.statusSince)
  const note = pod.notes?.trim()
  const reason = shown === 'attention' ? note || 'Marked for attention on Grow.' : h?.reason ?? ''
  const recent = pod.recent ?? []
  const perDay = typeof coverPerDay === 'number' ? `${coverPerDay >= 0 ? '+' : '−'}${Math.abs(coverPerDay * 100).toFixed(1)}% a day` : null
  const verdict = pod.verdict ? TREND[pod.verdict] : undefined
  const trend = verdict ? `${verdict}${perDay ? `, ${perDay}` : ''}.` : perDay ? `${perDay} over the recent photos.` : 'Not enough photos yet for a trend.'
  const harvestWindow = h?.window ? `day ${h.window.source === 'camera' ? '~' : ''}${Math.round(h.window.start)}–${Math.round(h.window.end)}` : '—'
  return (
    <>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="font-mono text-[11px] tracking-[0.06em] text-fg-3">{`POD ${pod.slot} · TOWER ${tower}`}</div>
          <div className="truncate text-[19px] font-medium">{pod.plant ?? 'Empty'}</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer text-fg-3 hover:text-fg"><X size={16} /></button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: shown === 'empty' ? 'var(--text-2)' : SHOWN_TOKEN[shown] }}>
          <span className="size-[7px] rounded-full" style={{ background: SHOWN_TOKEN[shown] }} />
          {SHOWN_LABEL[shown]}
          {since && shown !== 'empty' && <span className="font-mono text-[11px] font-normal text-fg-3">{`· ${since}`}</span>}
        </div>
        {reason && <p className="text-[13px] leading-normal text-fg-2">{reason}</p>}
      </div>

      {form !== 'none' && <PlantModel key={`${pod.slot}|${pod.plant ?? ''}|${form}`} plant={pod.plant} today={form} seed={pod.slot} />}

      {pod.status !== 'empty' && <PodCrop slot={pod.slot} />}

      {pod.status !== 'empty' && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between font-mono text-[10px] font-medium tracking-[0.1em] text-fg-3">
            <span>LEAF COVER</span>
            <span className="text-fg">{cover === null ? '—' : pct(cover)}</span>
          </div>
          {recent.length > 1 && <LineChart series={[{ data: recent, color: 'var(--pod-ok)', width: 1.5 }]} height={40} />}
          <div className="text-xs text-fg-3">{trend}</div>
        </div>
      )}

      <div className="flex flex-col border-t border-line">
        <Row label="Plant">
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <input aria-label="Plant" list="grow-plants" value={draft.plant} onChange={e => onChange({ ...draft, plant: e.target.value })} placeholder="Pick a plant" className={INLINE} />
            <ChevronDown size={16} className="pointer-events-none shrink-0 text-fg-2" />
            <datalist id="grow-plants">{PLANTS.map(p => <option key={p} value={p} />)}</datalist>
          </span>
        </Row>
        <Row label="Status">
          <span className="flex items-center gap-1">
            <select aria-label="Status" value={draft.status} onChange={e => onChange({ ...draft, status: e.target.value as PodStatus })} className="cursor-pointer appearance-none bg-transparent text-right text-fg outline-none [field-sizing:content]">
              {STATUS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <ChevronDown size={16} className="pointer-events-none shrink-0 text-fg-2" />
          </span>
        </Row>
        <Row label="Notes">
          <input aria-label="Notes" value={draft.notes} onChange={e => onChange({ ...draft, notes: e.target.value })} placeholder="Add a note" className={INLINE} />
        </Row>
        <Row label="Seeded"><span className="font-mono">{plantedAt ? shortDate(plantedAt) : '—'}</span></Row>
        <Row label="Harvest window" last><span className="font-mono">{harvestWindow}</span></Row>
      </div>

      {dirty
        ? (
            <div className="flex gap-2">
              <Button variant="primary" full disabled={saving} onClick={onSave}>Save</Button>
              <Button onClick={onRevert}>Revert</Button>
            </div>
          )
        : (
            <div className="flex gap-2">
              <Link to="/cameras" className="flex flex-1 items-center justify-center gap-1.5 rounded-ctl border border-line-2 p-[9px] text-[13px] text-fg hover:bg-active">
                <Camera size={16} />
                Photos
              </Link>
              {shown === 'ready' && <Button onClick={onHarvested}>Mark harvested</Button>}
              {shown === 'attention' && <Button className="text-fg-2" onClick={onDismiss}>Dismiss</Button>}
            </div>
          )}
    </>
  )
}
