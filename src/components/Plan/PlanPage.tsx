import { keepPreviousData } from '@tanstack/react-query'
import { Box, EyeOff, LayoutGrid, LoaderCircle, Minus, Pencil, Plus, Sprout } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ZONE_COLOR } from '@/src/components/Grow/lightZones'
import { PlantThumb, podForm } from '@/src/components/Grow/PlantThumb'
import { SwapBanner, SwapProgress } from '@/src/components/Grow/SwapBanner'
import { PLANNED_FORM, podSide, type PodStatus } from '@/src/components/Grow/towerLayout'
import type { PodState } from '@/src/components/Grow/towerScene'
import { TowerView } from '@/src/components/Grow/TowerView'
import { useSwapPods } from '@/src/components/Grow/useSwapPods'
import { Button, Card, CardHeader, GhostIcon, InlineError, SectionLabel } from '@/src/components/ds/core'
import { SegmentedControl, TextField } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { trpc } from '@/src/utils/trpc'
import { CustomPlantDialog, type EditablePlant } from '@/src/components/Plan/CustomPlantDialog'
import { PodPanel } from '@/src/components/Plan/PodPanel'
import { SavedPlans } from '@/src/components/Plan/SavedPlans'
import { SeenEmpty } from '@/src/components/Plan/SeenEmpty'
import { SuggestedMoves } from '@/src/components/Plan/SuggestedMoves'
import { Unplaced } from '@/src/components/Plan/Unplaced'

type Model = 'home' | 'studio'
interface Overrides { pins?: { slot: number, plantId: string }[], allowedZones?: Record<string, Zone[]>, replant?: boolean }
type Zone = 'high' | 'medium' | 'low'
type Category = 'fruiting' | 'vegetable' | 'legume' | 'flower' | 'herb' | 'green' | 'lettuce'

/** Gardyn's zone colours (as on the 3D tower), tinted so pod text stays readable in either theme. */
const zoneStyle = (z: Zone) => ({ background: `color-mix(in oklab, ${ZONE_COLOR[z]} 20%, transparent)`, borderColor: `color-mix(in oklab, ${ZONE_COLOR[z]} 65%, transparent)` })
const ZONE_LABEL: Record<Zone, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const CATS: { value: Category | 'all', label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'lettuce', label: 'Lettuce' }, { value: 'green', label: 'Greens' }, { value: 'herb', label: 'Herbs' },
  { value: 'fruiting', label: 'Fruiting' }, { value: 'vegetable', label: 'Veg' }, { value: 'legume', label: 'Beans' }, { value: 'flower', label: 'Flowers' },
]

type View = '3d' | '2d'
export const VIEW_KEY = 'seedypod.planView'
const VIEWS: { value: View, label: ReactNode }[] = [
  { value: '3d', label: [<Box key="i" size={14} aria-hidden="true" />, '3D'] },
  { value: '2d', label: [<LayoutGrid key="i" size={14} aria-hidden="true" />, '2D'] },
]

/** The view this browser last picked; the 3D tower until it picks the grid. */
function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === '2d' ? '2d' : '3d'
  }
  catch {
    return '3d'
  }
}

interface Slot { slot: number, row: number, zone: string | null }
interface Assignment { slot: number, plantId: string, plantName: string, reason: string, fallback: number, shift?: 'lower' | 'higher' | null, fit?: 'ideal' | 'ok' | 'outside' }
interface Planted { slot: number, status: PodStatus, plant: string | null, seenEmpty?: boolean }

/** Outlines a pod placed outside the zones its plant does well in: solid amber below them (less light), dashed above them (more light). */
const SHIFT_OUTLINE = { lower: 'outline outline-1 outline-[var(--status-warn)]', higher: 'outline-dashed outline-1 outline-[var(--accent-light)]' }

/** Which way a pod sits outside the zones its plant does well in; null when it is in its ideal zone or ok where it is. */
function offZone(a: Assignment | undefined): 'lower' | 'higher' | null {
  return a?.fit === 'outside' ? a.shift ?? null : null
}

/**
 * What the caption says about pods outside the zones their plant does well
 * in, lower and higher apart. Pods in a zone their plant tolerates are ok
 * there and go unmentioned.
 */
export function shiftNotes(assignments: Assignment[], view: '2d' | '3d'): string {
  const lower = assignments.some(a => offZone(a) === 'lower')
  const higher = assignments.some(a => offZone(a) === 'higher')
  const lowerText = 'lower than the zones their plant does well in, so expect slower growth'
  const higherText = 'higher than the zones their plant does well in, in more light than it likes'
  if (view === '2d') {
    return [
      lower ? ` Outlined pods sit ${lowerText}.` : '',
      higher ? ` Dashed outlines sit ${higherText}.` : '',
    ].join('')
  }
  return [
    lower ? ` Some sit ${lowerText}.` : '',
    higher ? ` Some sit ${higherText}.` : '',
  ].join('')
}

/**
 * Pins for every planned pod where it sits, with the plant at `from` moved to
 * `to` and whatever was planned there moved back to `from`, so the layout
 * keeps the swap.
 */
export function swapPins(assignments: readonly Assignment[], from: number, to: number): { slot: number, plantId: string }[] {
  return assignments.map(a => ({ slot: a.slot === from ? to : a.slot === to ? from : a.slot, plantId: a.plantId }))
}

/** The planned pods with whatever was planned at `from` and at `to` traded. */
function swapPlanned(bySlot: ReadonlyMap<number, Assignment>, from: number, to: number): Map<number, Assignment> {
  const out = new Map(bySlot)
  const [a, b] = [bySlot.get(from), bySlot.get(to)]
  out.delete(from)
  out.delete(to)
  if (a) out.set(to, { ...a, slot: to })
  if (b) out.set(from, { ...b, slot: from })
  return out
}

/** Pins for every planned pod where it sits, with `slot` given `plantId` instead (or left empty), so the rest of the layout holds still. */
function placePins(assignments: readonly Assignment[], slot: number, plantId: string | null): { slot: number, plantId: string }[] {
  return [...assignments.filter(a => a.slot !== slot).map(a => ({ slot: a.slot, plantId: a.plantId })), ...(plantId ? [{ slot, plantId }] : [])]
}

/**
 * The flat grid of slots, tinted by zone: each planned or planted plant pictured and named (planted ones italic), pods outside the zones their plant does well in outlined.
 * A tap opens the pod (`onOpen`); while a swap is being picked (`swapping`), it picks the other pod instead. A plant also drags onto another pod to swap them (`onSwap`).
 * Pods in a swap still on its way (`busy`) pulse.
 */
function PlanGrid({ cols, slots, bySlot, planted, open, swapping, busy, onOpen, onSwapping, onSwap }: { cols: number, slots: Slot[], bySlot: Map<number, Assignment>, planted: Map<number, Planted>, open: number | null, swapping: number | null, busy: readonly number[], onOpen: (slot: number) => void, onSwapping: (slot: number | null) => void, onSwap: (from: number, to: number) => void }) {
  // The pod a drag is over, ringed so it's clear where the drop lands.
  const [over, setOver] = useState<number | null>(null)
  const swap = (from: number, to: number) => {
    onSwapping(null)
    setOver(null)
    onSwap(from, to)
  }
  return (
    <div data-testid="plan-grid" className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {slots.map((s) => {
        const a = bySlot.get(s.slot)
        const ex = planted.get(s.slot)
        const z = (s.zone ?? 'medium') as Zone
        const plant = a?.plantName ?? ex?.plant ?? null
        const off = offZone(a)
        const moving = busy.includes(s.slot)
        return (
          <div
            key={s.slot}
            data-slot={s.slot}
            role="button"
            tabIndex={0}
            aria-pressed={open === s.slot}
            aria-busy={moving || undefined}
            aria-label={`Pod ${s.slot}${plant ? `, ${plant}` : ''}${ex?.seenEmpty ? ', cameras see it empty' : ''}`}
            draggable={!!(a || ex)}
            onDragStart={e => e.dataTransfer.setData('text/plain', String(s.slot))}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(s.slot)
            }}
            onDragLeave={() => setOver(o => (o === s.slot ? null : o))}
            onDragEnd={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault()
              swap(Number(e.dataTransfer.getData('text/plain')), s.slot)
            }}
            onClick={() => {
              // A swap's plant lands here, so the panel follows it.
              if (swapping !== null) swap(swapping, s.slot)
              onOpen(s.slot)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.currentTarget.click()
              }
            }}
            className={cn('flex min-h-[58px] flex-col justify-center gap-0.5 rounded-[var(--radius-ctl)] border px-2 py-1', 'w-[85%]', podSide(s.row) === 1 ? 'justify-self-end' : 'justify-self-start', off ? SHIFT_OUTLINE[off] : '', a || ex ? 'cursor-grab' : 'cursor-pointer', (open === s.slot || swapping === s.slot) && 'ring-2 ring-fg', over === s.slot && open !== s.slot && 'ring-2 ring-fg-3', moving && 'animate-pulse motion-reduce:animate-none')}
            style={zoneStyle(z)}
            title={a?.reason ?? ex?.plant ?? `${ZONE_LABEL[z]} light`}
          >
            <div className="flex items-center justify-between font-mono text-[10px] text-fg-3">
              <span className="flex items-center gap-1">
                {s.slot}
                {ex?.seenEmpty && <EyeOff size={10} aria-hidden="true" data-testid="seen-empty" />}
                {moving && <LoaderCircle size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              </span>
              <span>{z === 'medium' ? 'med' : z}</span>
            </div>
            {plant && (
              <div className={cn('flex min-w-0 items-center gap-1.5', ex?.seenEmpty && 'opacity-50')}>
                <PlantThumb plant={plant} stage={a ? PLANNED_FORM : podForm(ex ?? { status: 'empty' })} size={24} />
                <span className={cn('min-w-0 truncate text-[12px] leading-tight', a ? 'text-fg' : 'text-fg-2 italic')}>{plant}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The same slots on the 3D tower, collars coloured by zone. A planned pod shows
 * its plant grown, with why it sits there in its callout; a planted one keeps
 * its own state.
 */
export function planPods(slots: Slot[], bySlot: Map<number, Assignment>, planted: Map<number, Planted>): PodState[] {
  return slots.map((s): PodState => {
    const a = bySlot.get(s.slot)
    if (a) return { slot: s.slot, status: 'seeded', plant: a.plantName, planned: true, harvest: { state: 'unknown', window: null, cover: null, targetCover: 0, daysToReady: null, daysLeft: null, reason: `Planned: ${a.reason}.` } }
    return planted.get(s.slot) ?? { slot: s.slot, status: 'empty', plant: null }
  })
}

export function PlanPage() {
  const utils = trpc.useUtils()
  const [model, setModel] = useState<Model>('home')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<Category | 'all'>('all')
  const [picks, setPicks] = useState<Record<string, number>>({})
  const [name, setName] = useState('My plan')
  const [mode, setMode] = useState<'staggered' | 'batch'>('staggered')
  const [editing, setEditing] = useState<EditablePlant | 'new' | null>(null)
  // A saved plan loaded for editing: saving updates it, with its own start date and overrides, so it lays out and sows as saved.
  const [opened, setOpened] = useState<{ id: string, start: string | null, overrides?: Overrides } | null>(null)
  const [view, setView] = useState<View>(savedView)
  const [noWebGL, setNoWebGL] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  // The pod open beside the 2D grid, and the one whose swap is being picked.
  const [open, setOpen] = useState<number | null>(null)
  const [swapping, setSwapping] = useState<number | null>(null)
  // A swap shows at once: until the unit has the records and the plan is laid out again, its two pods trade places here.
  const [moving, setMoving] = useState<{ from: number, to: number } | null>(null)
  const chooseView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    }
    catch {
      // private window: the choice lasts for this visit
    }
  }

  const zones = trpc.planner.zones.useQuery({ model })
  // Every plant, custom ones included, so saved plans can name theirs.
  const everything = trpc.planner.catalog.useQuery({})
  const catalog = trpc.planner.catalog.useQuery({ q: q || undefined, category: cat === 'all' ? undefined : cat })
  const request = useMemo(() => Object.entries(picks).filter(([, n]) => n > 0).map(([plantId, count]) => ({ plantId, count })), [picks])
  // Swaps on the grid pin pods; until a plan is saved or another opened they live here.
  const [edited, setEdited] = useState<Overrides | undefined>(undefined)
  const overrides = edited ?? opened?.overrides
  const start = opened?.start ?? undefined
  const swapPods = useSwapPods()
  // The last layout stays up while the next is worked out, and none is asked for while records are moving, which it would place around.
  const layout = trpc.planner.layout.useQuery({ model, plants: request, respectExisting: true, suggestMoves: true, ...(overrides && { overrides }) }, { placeholderData: keepPreviousData, enabled: !swapPods.isPending })
  const sowing = trpc.planner.sowing.useQuery({ plants: request, mode, ...(start && { start }) }, { enabled: request.length > 0 })
  const pods = trpc.grow.pods.useQuery()
  const seen = trpc.vision.seenEmpty.useQuery()
  const plans = trpc.planner.plans.useQuery()
  const save = trpc.planner.savePlan.useMutation({ onSuccess: () => utils.planner.plans.invalidate() })
  const apply = trpc.planner.applyPlan.useMutation({
    onSuccess: () => {
      void utils.planner.invalidate()
      void utils.grow.invalidate()
    },
  })
  const remove = trpc.planner.removePlan.useMutation({ onSuccess: () => utils.planner.plans.invalidate() })
  const updatePod = trpc.grow.updatePod.useMutation({ onSuccess: () => utils.grow.invalidate() })

  const total = request.reduce((s, r) => s + r.count, 0)
  // Pods the plan leaves empty: neither planted now nor planned.
  const empty = layout.data?.free.length ?? (zones.data ? zones.data.slots.length - (pods.data ?? []).filter(p => p.status !== 'empty' && p.slot <= zones.data.slots.length).length : 0)
  const laidOut = new Map((layout.data?.assignments ?? []).map(a => [a.slot, a]))
  const settling = swapPods.isPending || !!layout.isPlaceholderData
  const bySlot = moving && settling ? swapPlanned(laidOut, moving.from, moving.to) : laidOut
  // Laid out again: the layout shows the swap itself.
  if (moving && !settling) setMoving(null)
  // A replant lays out the whole tower, so nothing planted now holds a pod.
  const seenSlots = new Set((seen.data ?? []).map(s => s.slot))
  const planted = new Map(overrides?.replant ? [] : (pods.data ?? []).filter(p => p.status !== 'empty').map(p => [p.slot, { slot: p.slot, status: p.status, plant: p.plant, ...(seenSlots.has(p.slot) && { seenEmpty: true }) }]))
  const swap = (from: number, to: number) => {
    setMoving({ from, to })
    setEdited({ ...overrides, pins: swapPins([...bySlot.values()], from, to) })
  }
  // A planted pod's record moves with its yCube; a plant planned on either side moves the other way, laid out once the records have.
  const move = (from: number, to: number) => {
    const was = edited
    setMoving({ from, to })
    if (bySlot.has(from) || bySlot.has(to)) swap(from, to)
    swapPods.mutate({ a: from, b: to }, {
      onError: () => {
        setEdited(was)
        setMoving(null)
      },
    })
  }
  // Any pod onto any other, on the grid or the tower: pods with a plant in either swap their records, plans alone their pins. One swap at a time.
  const exchange = (from: number, to: number) => {
    if (from === to || moving) return
    if (planted.has(from) || planted.has(to)) move(from, to)
    else if (bySlot.has(from) || bySlot.has(to)) swap(from, to)
  }
  const bump = (id: string, d: number) => {
    const count = Math.max(0, (picks[id] ?? 0) + d)
    setPicks(p => ({ ...p, [id]: count }))
    // A pin adds a pod of its own, so fewer of a plant drops its pins past the new count.
    if (d < 0 && overrides?.pins?.some(p => p.plantId === id)) {
      let kept = 0
      setEdited({ ...overrides, pins: overrides.pins.filter(p => p.plantId !== id || kept++ < count) })
    }
  }
  // A pod in the tower takes the plant in its own record; any other is planned with it, counted in the picks, the rest of the layout pinned where it sits.
  const plantAt = (slot: number, plantId: string | null) => {
    if (planted.has(slot)) {
      const plant = everything.data?.plants.find(p => p.id === plantId)
      updatePod.mutate(plant ? { slot, plant: plant.name } : { slot, plant: null, plantedAt: null, status: 'empty', notes: '' })
      return
    }
    const was = bySlot.get(slot)?.plantId ?? null
    if (was === plantId) return
    if (was) bump(was, -1)
    if (plantId) bump(plantId, 1)
    setEdited({ ...overrides, pins: placePins([...bySlot.values()], slot, plantId) })
  }
  // The zones this plan may put a plant in: the plan's own, else its ideal and the ones it tolerates.
  const zonesFor = (plantId: string | null) => {
    const p = everything.data?.plants.find(x => x.id === plantId)
    if (!p) return undefined
    const own = overrides?.allowedZones?.[p.id]
    return { allowed: own ?? [p.zone, ...p.tolerates.map(t => t.zone)], own: !!own }
  }
  const setZones = (plantId: string, allowed: Zone[] | null) => {
    const rest = Object.entries(overrides?.allowedZones ?? {}).filter(([id]) => id !== plantId)
    setEdited({ ...overrides, allowedZones: Object.fromEntries(allowed ? [...rest, [plantId, allowed]] : rest) })
  }
  const shown: View = noWebGL ? '2d' : view
  const openSlot = open === null ? undefined : zones.data?.slots.find(s => s.slot === open)
  const openPlantId = openSlot ? bySlot.get(openSlot.slot)?.plantId ?? everything.data?.plants.find(p => p.name === planted.get(openSlot.slot)?.plant)?.id ?? null : null

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <PageHeader
        title="Plan"
        right={(
          <div className="flex flex-wrap gap-2">
            {!noWebGL && <SegmentedControl<View> size="sm" ariaLabel="Plan view" value={shown} onChange={chooseView} options={VIEWS} />}
            <SegmentedControl<Model>
              size="sm"
              value={model}
              onChange={(m) => {
                setModel(m)
                setSelected(null)
                setOpen(null)
                setSwapping(null)
                setEdited(undefined)
              }}
              options={[{ value: 'home', label: 'Home · 30' }, { value: 'studio', label: 'Studio · 16' }]}
            />
          </div>
        )}
      />

      <div className="grid gap-4 min-[900px]:grid-cols-[1fr_360px]">
        <Card id="plan-layout" className="scroll-mt-4">
          <CardHeader
            title="Layout"
            subtitle={`${total} planned · ${empty} empty · zones from Gardyn’s light map`}
            icon={LayoutGrid}
            right={(
              <div className="flex gap-2 text-[11px]">
                {(['high', 'medium', 'low'] as Zone[]).map(z => (
                  <span key={z} className="rounded-[var(--radius-tag)] border px-1.5 py-0.5" style={zoneStyle(z)}>
                    {ZONE_LABEL[z]}
                    {' '}
                    {zones.data?.counts[z]}
                  </span>
                ))}
              </div>
            )}
          />
          <SeenEmpty slots={[...planted.values()].filter(p => p.seenEmpty && p.slot <= (zones.data?.slots.length ?? 0)).map(p => p.slot)} />
          {zones.data && shown === '2d' && (
            <div className="mt-3 flex flex-col gap-3 min-[640px]:flex-row min-[640px]:items-start">
              <div className="min-w-0 flex-1">
                {swapping !== null && <SwapBanner slot={swapping} plant={bySlot.get(swapping)?.plantName ?? planted.get(swapping)?.plant} onCancel={() => setSwapping(null)} />}
                {moving && <SwapProgress a={moving.from} b={moving.to} />}
                <PlanGrid cols={zones.data.cols} slots={zones.data.slots} bySlot={bySlot} planted={planted} open={open} swapping={swapping} busy={moving ? [moving.from, moving.to] : []} onOpen={setOpen} onSwapping={setSwapping} onSwap={exchange} />
              </div>
              {openSlot && (
                <PodPanel
                  key={openSlot.slot}
                  slot={openSlot.slot}
                  zone={(openSlot.zone ?? 'medium') as Zone}
                  plant={bySlot.get(openSlot.slot)?.plantName ?? planted.get(openSlot.slot)?.plant ?? null}
                  plantId={openPlantId}
                  reason={bySlot.get(openSlot.slot)?.reason}
                  planted={planted.has(openSlot.slot)}
                  plants={everything.data?.plants ?? []}
                  zones={zonesFor(openPlantId)}
                  onZones={z => setZones(openPlantId as string, z)}
                  onPlant={id => plantAt(openSlot.slot, id || null)}
                  onSwap={() => setSwapping(openSlot.slot)}
                  onClose={() => {
                    setOpen(null)
                    setSwapping(null)
                  }}
                />
              )}
            </div>
          )}
          {zones.data && shown === '3d' && (
            <div className="mt-3">
              {moving && <SwapProgress a={moving.from} b={moving.to} />}
              <TowerView
                pods={planPods(zones.data.slots, bySlot, planted)}
                waterPct={null}
                // Lit, so the zones read, whatever the light is doing now.
                lightLevel={100}
                zones
                selected={selected}
                onSelect={setSelected}
                onSwap={exchange}
                onClose={() => setSelected(null)}
                onUnavailable={() => setNoWebGL(true)}
              />
            </div>
          )}
          {swapPods.error && <InlineError>{swapPods.error.message}</InlineError>}
          {updatePod.error && <InlineError>{updatePod.error.message}</InlineError>}
          {noWebGL && <p className="mt-2 text-xs text-fg-3">The 3D tower needs WebGL, which this browser doesn&apos;t offer, so the plan is shown as a grid.</p>}
          <Unplaced unplaced={layout.data?.unplaced ?? []} suggestions={layout.data?.suggestions ?? []} />
          <p className="mt-2 text-[12px] text-fg-3">
            {shown === '2d'
              ? `Tap a pod to change its plant or swap it, or drag a plant onto another pod to swap them. Italic = in the tower now.${shiftNotes(layout.data?.assignments ?? [], '2d')}`
              : `Planned pods show their plant grown, ringed by light zone; click one for why it sits there, or drag one onto another pod to swap them.${shiftNotes(layout.data?.assignments ?? [], '3d')}`}
          </p>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <SuggestedMoves moves={layout.data?.moves ?? []} onApply={exchange} />
          <Card>
            <CardHeader title="Plants" subtitle="Gardyn catalog and yours · zone, first harvest" icon={Sprout} right={<Button size="sm" icon={Plus} onClick={() => setEditing('new')}>Add plant</Button>} />
            <TextField className="mt-3" mono={false} value={q} onChange={setQ} placeholder="Search basil, kale, pepper…" aria-label="Search plants" />
            <div className="mt-2 flex flex-wrap gap-1">
              {CATS.map(c => <button key={c.value} type="button" onClick={() => setCat(c.value)} className={cn('rounded-full border px-2 py-0.5 text-[11px]', cat === c.value ? 'border-fg-2 text-fg' : 'border-line text-fg-3')}>{c.label}</button>)}
            </div>
            <div className="mt-2 max-h-[420px] overflow-y-auto">
              {(catalog.data?.plants ?? []).map(p => (
                <div key={p.id} className="flex items-center gap-2 border-b border-line py-1.5 last:border-0">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: ZONE_COLOR[p.zone], borderColor: ZONE_COLOR[p.zone] }} title={`${ZONE_LABEL[p.zone]} light`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">
                      {p.name}
                      {p.custom ? <span className="ml-1 text-[10px] text-fg-3">(yours)</span> : !p.inStore && <span className="ml-1 text-[10px] text-fg-3">(guide only)</span>}
                    </div>
                    <div className="text-[11px] text-fg-3">{`${p.harvestMonths[0]}–${p.harvestMonths[1]} mo${p.harvestEstimated ? '*' : ''} · ${p.careLevel ?? '—'}`}</div>
                  </div>
                  {p.custom && <GhostIcon icon={Pencil} label={`Edit ${p.name}`} onClick={() => setEditing(p)} />}
                  <GhostIcon icon={Minus} label={`Remove ${p.name}`} onClick={() => bump(p.id, -1)} disabled={!picks[p.id]} />
                  <span className="w-4 text-center font-mono text-[12px]">{picks[p.id] ?? 0}</span>
                  <GhostIcon icon={Plus} label={`Add ${p.name}`} onClick={() => bump(p.id, 1)} />
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-fg-3">* harvest window estimated from the category; Gardyn doesn’t list one.</p>
          </Card>
        </div>
      </div>

      {request.length > 0 && (
        <>
          <SectionLabel right={<SegmentedControl size="sm" value={mode} onChange={setMode} options={[{ value: 'staggered', label: 'Staggered' }, { value: 'batch', label: 'All now' }]} />}>Sowing schedule</SectionLabel>
          <Card>
            {(sowing.data ?? []).map((w, i) => (
              // All-now mode gives every pod of a plant the same wave and date, so the index keeps keys unique.
              <div key={`${w.plantId}-${i}`} className="flex items-center justify-between border-b border-line py-1.5 text-[13px] last:border-0">
                <span>
                  {w.plantName}
                  {w.wave > 1 && <span className="ml-1 text-fg-3">{`wave ${w.wave}`}</span>}
                </span>
                <span className="font-mono text-[12px] text-fg-2">{`sow ${w.sowOn} → harvest ${w.firstHarvestFrom} – ${w.firstHarvestTo}${w.harvestEstimated ? '*' : ''}`}</span>
              </div>
            ))}
            <p className="mt-2 text-[11px] text-fg-3">Staggered follows Gardyn’s succession guidance: start the next yCube once the previous one is harvest-ready, plus 1–2 weeks (fast greens), 2–4 (long greens & herbs), 3–6 (beans, peas, cucumbers) or 6–10 (tomatoes, peppers, eggplant, strawberries).</p>
          </Card>
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Plan name" mono={false} value={name} onChange={setName} className="min-w-[220px]" />
            <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate({ id: opened?.id ?? `plan-${Date.now().toString(36)}`, name, model, mode, plants: request, ...(start && { start }), ...(overrides && { overrides }) })}>{opened ? 'Update plan' : 'Save plan'}</Button>
            <Button
              onClick={() => {
                setPicks({})
                setOpened(null)
                setEdited(undefined)
              }}
            >
              Clear
            </Button>
          </div>
        </>
      )}

      <SectionLabel>Saved plans</SectionLabel>
      <SavedPlans
        plans={plans.data ?? []}
        catalog={everything.data?.plants ?? []}
        editing={opened?.id ?? null}
        onOpen={(p) => {
          setModel(p.model === 'studio' ? 'studio' : 'home')
          setPicks(Object.fromEntries(p.request.map(r => [r.plantId, r.count])))
          setMode(p.mode)
          setName(p.name)
          setOpened({ id: p.id, start: p.start, overrides: p.layout.overrides })
          setEdited(undefined)
          setSelected(null)
          setOpen(null)
          setSwapping(null)
          document.getElementById('plan-layout')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        }}
        onApply={id => apply.mutate({ id })}
        onRemove={id => remove.mutate({ id })}
      />
      <CustomPlantDialog open={editing !== null} plant={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      {apply.data && (
        <p className="text-[12px] text-fg-2">{`Applied: ${apply.data.seeded.length} pods seeded${apply.data.scheduled.length ? `, ${apply.data.scheduled.length} scheduled` : ''}.`}</p>
      )}
    </div>
  )
}
