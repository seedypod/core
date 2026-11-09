import { Box, LayoutGrid, Minus, Pencil, Plus, Sprout, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ZONE_COLOR } from '@/src/components/Grow/lightZones'
import { PlantThumb, podForm } from '@/src/components/Grow/PlantThumb'
import { PLANNED_FORM, type PodStatus } from '@/src/components/Grow/towerLayout'
import type { PodState } from '@/src/components/Grow/towerScene'
import { TowerView } from '@/src/components/Grow/TowerView'
import { Badge, Button, Card, CardHeader, GhostIcon, SectionLabel } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, TextField } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { trpc } from '@/src/utils/trpc'
import { CustomPlantDialog, type EditablePlant } from '@/src/components/Plan/CustomPlantDialog'
import { Unplaced } from '@/src/components/Plan/Unplaced'

type Model = 'home' | 'studio'
interface Overrides { pins?: { slot: number, plantId: string }[], allowedZones?: Record<string, Zone[]> }
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

interface Slot { slot: number, zone: string | null }
interface Assignment { slot: number, plantName: string, reason: string, fallback: number }
interface Planted { slot: number, status: PodStatus, plant: string | null }

/** The flat grid of slots, tinted by zone: each planned or planted plant pictured and named (planted ones italic), fallbacks outlined. */
function PlanGrid({ cols, slots, bySlot, planted }: { cols: number, slots: Slot[], bySlot: Map<number, Assignment>, planted: Map<number, Planted> }) {
  return (
    <div data-testid="plan-grid" className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {slots.map((s) => {
        const a = bySlot.get(s.slot)
        const ex = planted.get(s.slot)
        const z = (s.zone ?? 'medium') as Zone
        const plant = a?.plantName ?? ex?.plant ?? null
        return (
          <div key={s.slot} data-slot={s.slot} className={cn('flex min-h-[58px] flex-col justify-center gap-0.5 rounded-[var(--radius-ctl)] border px-2 py-1', a?.fallback ? 'outline outline-1 outline-[var(--status-warn)]' : '')} style={zoneStyle(z)} title={a?.reason ?? ex?.plant ?? `${ZONE_LABEL[z]} light`}>
            <div className="flex items-center justify-between font-mono text-[10px] text-fg-3">
              <span>{s.slot}</span>
              <span>{z === 'medium' ? 'med' : z}</span>
            </div>
            {plant && (
              <div className="flex min-w-0 items-center gap-1.5">
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
  const [confirm, setConfirm] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditablePlant | 'new' | null>(null)
  // A saved plan loaded for editing: saving updates it, with its own start date and overrides, so it lays out and sows as saved.
  const [opened, setOpened] = useState<{ id: string, start: string | null, overrides?: Overrides } | null>(null)
  const [view, setView] = useState<View>(savedView)
  const [noWebGL, setNoWebGL] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
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
  const catalog = trpc.planner.catalog.useQuery({ q: q || undefined, category: cat === 'all' ? undefined : cat })
  const request = useMemo(() => Object.entries(picks).filter(([, n]) => n > 0).map(([plantId, count]) => ({ plantId, count })), [picks])
  const overrides = opened?.overrides
  const start = opened?.start ?? undefined
  const layout = trpc.planner.layout.useQuery({ model, plants: request, respectExisting: true, ...(overrides && { overrides }) }, { enabled: true })
  const sowing = trpc.planner.sowing.useQuery({ plants: request, mode, ...(start && { start }) }, { enabled: request.length > 0 })
  const pods = trpc.grow.pods.useQuery()
  const plans = trpc.planner.plans.useQuery()
  const save = trpc.planner.savePlan.useMutation({ onSuccess: () => utils.planner.plans.invalidate() })
  const apply = trpc.planner.applyPlan.useMutation({
    onSuccess: () => {
      void utils.planner.invalidate()
      void utils.grow.invalidate()
    },
  })
  const remove = trpc.planner.removePlan.useMutation({ onSuccess: () => utils.planner.plans.invalidate() })

  const total = request.reduce((s, r) => s + r.count, 0)
  const free = zones.data ? zones.data.slots.length - (pods.data ?? []).filter(p => p.status !== 'empty' && p.slot <= zones.data.slots.length).length : 0
  const bySlot = new Map((layout.data?.assignments ?? []).map(a => [a.slot, a]))
  const planted = new Map((pods.data ?? []).filter(p => p.status !== 'empty').map(p => [p.slot, { slot: p.slot, status: p.status, plant: p.plant }]))
  const bump = (id: string, d: number) => setPicks(p => ({ ...p, [id]: Math.max(0, (p[id] ?? 0) + d) }))
  const shown: View = noWebGL ? '2d' : view
  const fallbacks = (layout.data?.assignments ?? []).some(a => a.fallback)

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
              }}
              options={[{ value: 'home', label: 'Home · 30' }, { value: 'studio', label: 'Studio · 16' }]}
            />
          </div>
        )}
      />

      <div className="grid gap-4 min-[900px]:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader
            title="Layout"
            subtitle={`${total} planned · ${free} free · zones from Gardyn’s light map`}
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
          {zones.data && shown === '2d' && <PlanGrid cols={zones.data.cols} slots={zones.data.slots} bySlot={bySlot} planted={planted} />}
          {zones.data && shown === '3d' && (
            <div className="mt-3">
              <TowerView
                pods={planPods(zones.data.slots, bySlot, planted)}
                waterPct={null}
                // Lit, so the zones read, whatever the light is doing now.
                lightLevel={100}
                zones
                selected={selected}
                onSelect={setSelected}
                onClose={() => setSelected(null)}
                onUnavailable={() => setNoWebGL(true)}
              />
            </div>
          )}
          {noWebGL && <p className="mt-2 text-xs text-fg-3">The 3D tower needs WebGL, which this browser doesn&apos;t offer, so the plan is shown as a grid.</p>}
          <Unplaced unplaced={layout.data?.unplaced ?? []} suggestions={layout.data?.suggestions ?? []} />
          <p className="mt-2 text-[12px] text-fg-3">
            {shown === '2d'
              ? `Italic = already planted.${fallbacks ? ' Outlined pods sit one zone lower than ideal — Gardyn’s rule when the ideal zone is full.' : ''}`
              : `Planned pods show their plant grown, ringed by light zone; click one for why it sits there.${fallbacks ? ' Some sit one zone lower than ideal — Gardyn’s rule when the ideal zone is full.' : ''}`}
          </p>
        </Card>

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
              }}
            >
              Clear
            </Button>
          </div>
        </>
      )}

      <SectionLabel>Saved plans</SectionLabel>
      {(plans.data ?? []).length === 0 && <Card dashed><p className="text-[13px] text-fg-2">Pick plants above, then save a plan. Applying it writes the layout onto your pods and schedules reminders for later waves.</p></Card>}
      {(plans.data ?? []).map(p => (
        <Card key={p.id} highlight={!!p.appliedAt}>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[15px]">
                {p.name}
                {' '}
                {p.appliedAt && <Badge variant="active">applied</Badge>}
              </div>
              <div className="text-[12px] text-fg-2">
                {p.model}
                {' '}
                ·
                {' '}
                {p.layout.assignments.length}
                {' '}
                pods ·
                {' '}
                {p.request.map(r => `${r.count}× ${r.plantId}`).join(', ')}
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setModel(p.model === 'studio' ? 'studio' : 'home')
                setPicks(Object.fromEntries(p.request.map(r => [r.plantId, r.count])))
                setMode(p.mode)
                setName(p.name)
                setOpened({ id: p.id, start: p.start, overrides: p.layout.overrides })
              }}
            >
              Open
            </Button>
            <Button size="sm" variant="primary" onClick={() => setConfirm(p.id)}>Apply</Button>
            <GhostIcon icon={Trash2} label="Delete plan" onClick={() => remove.mutate({ id: p.id })} />
          </div>
        </Card>
      ))}

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Apply plan to your pods?"
        icon={LayoutGrid}
        footer={(
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                if (confirm) apply.mutate({ id: confirm })
                setConfirm(null)
              }}
            >
              Apply
            </Button>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        )}
      >
        <p className="text-[13px] text-fg-2">This overwrites the planned pods. First-wave pods are marked seeded today; later waves are noted with their sow date and you’ll get a reminder when it arrives.</p>
      </Modal>
      <CustomPlantDialog open={editing !== null} plant={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      {apply.data && (
        <p className="text-[12px] text-fg-2">{`Applied: ${apply.data.seeded.length} pods seeded${apply.data.scheduled.length ? `, ${apply.data.scheduled.length} scheduled` : ''}.`}</p>
      )}
    </div>
  )
}
