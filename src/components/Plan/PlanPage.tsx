import { LayoutGrid, Minus, Plus, Sprout, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { ZONE_COLOR } from '@/src/components/Grow/lightZones'
import { Badge, Button, Card, CardHeader, GhostIcon, SectionLabel } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, TextField } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { trpc } from '@/src/utils/trpc'
import { Unplaced } from '@/src/components/Plan/Unplaced'

type Model = 'home' | 'studio'
type Zone = 'high' | 'medium' | 'low'
type Category = 'fruiting' | 'vegetable' | 'legume' | 'flower' | 'herb' | 'green' | 'lettuce'

/** Gardyn's zone colours (as on the 3D tower), tinted so pod text stays readable in either theme. */
const zoneStyle = (z: Zone) => ({ background: `color-mix(in oklab, ${ZONE_COLOR[z]} 20%, transparent)`, borderColor: `color-mix(in oklab, ${ZONE_COLOR[z]} 65%, transparent)` })
const ZONE_LABEL: Record<Zone, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const CATS: { value: Category | 'all', label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'lettuce', label: 'Lettuce' }, { value: 'green', label: 'Greens' }, { value: 'herb', label: 'Herbs' },
  { value: 'fruiting', label: 'Fruiting' }, { value: 'vegetable', label: 'Veg' }, { value: 'legume', label: 'Beans' }, { value: 'flower', label: 'Flowers' },
]

export function PlanPage() {
  const utils = trpc.useUtils()
  const [model, setModel] = useState<Model>('home')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<Category | 'all'>('all')
  const [picks, setPicks] = useState<Record<string, number>>({})
  const [name, setName] = useState('My plan')
  const [mode, setMode] = useState<'staggered' | 'batch'>('staggered')
  const [confirm, setConfirm] = useState<string | null>(null)

  const zones = trpc.planner.zones.useQuery({ model })
  const catalog = trpc.planner.catalog.useQuery({ q: q || undefined, category: cat === 'all' ? undefined : cat })
  const request = useMemo(() => Object.entries(picks).filter(([, n]) => n > 0).map(([plantId, count]) => ({ plantId, count })), [picks])
  const layout = trpc.planner.layout.useQuery({ model, plants: request, respectExisting: true }, { enabled: true })
  const sowing = trpc.planner.sowing.useQuery({ plants: request, mode }, { enabled: request.length > 0 })
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
  const existing = new Map((pods.data ?? []).filter(p => p.status !== 'empty').map(p => [p.slot, p.plant ?? '']))
  const bump = (id: string, d: number) => setPicks(p => ({ ...p, [id]: Math.max(0, (p[id] ?? 0) + d) }))

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <PageHeader title="Plan" right={<SegmentedControl<Model> size="sm" value={model} onChange={setModel} options={[{ value: 'home', label: 'Home · 30' }, { value: 'studio', label: 'Studio · 16' }]} />} />

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
          {zones.data && (
            <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${zones.data.cols}, minmax(0, 1fr))` }}>
              {zones.data.slots.map((s) => {
                const a = bySlot.get(s.slot)
                const ex = existing.get(s.slot)
                const z = (s.zone ?? 'medium') as Zone
                return (
                  <div key={s.slot} className={cn('flex min-h-[46px] flex-col justify-center rounded-[var(--radius-ctl)] border px-2 py-1', a?.fallback ? 'outline outline-1 outline-[var(--status-warn)]' : '')} style={zoneStyle(z)} title={a?.reason ?? ex ?? `${ZONE_LABEL[z]} light`}>
                    <div className="flex items-center justify-between font-mono text-[10px] text-fg-3">
                      <span>{s.slot}</span>
                      <span>{z === 'medium' ? 'med' : z}</span>
                    </div>
                    <div className={cn('truncate text-[12px] leading-tight', a ? 'text-fg' : ex ? 'text-fg-2 italic' : 'text-fg-3')}>{a?.plantName ?? ex ?? ''}</div>
                  </div>
                )
              })}
            </div>
          )}
          <Unplaced unplaced={layout.data?.unplaced ?? []} suggestions={layout.data?.suggestions ?? []} />
          <p className="mt-2 text-[12px] text-fg-3">{`Italic = already planted.${(layout.data?.assignments ?? []).some(a => a.fallback) ? ' Outlined pods sit one zone lower than ideal — Gardyn’s rule when the ideal zone is full.' : ''}`}</p>
        </Card>

        <Card>
          <CardHeader title="Plants" subtitle="Gardyn catalog · zone, first harvest" icon={Sprout} />
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
                    {!p.inStore && <span className="ml-1 text-[10px] text-fg-3">(guide only)</span>}
                  </div>
                  <div className="text-[11px] text-fg-3">{`${p.harvestMonths[0]}–${p.harvestMonths[1]} mo${p.harvestEstimated ? '*' : ''} · ${p.careLevel ?? '—'}`}</div>
                </div>
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
            <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate({ id: `plan-${Date.now().toString(36)}`, name, model, mode, plants: request })}>Save plan</Button>
            <Button onClick={() => setPicks({})}>Clear</Button>
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
      {apply.data && (
        <p className="text-[12px] text-fg-2">{`Applied: ${apply.data.seeded.length} pods seeded${apply.data.scheduled.length ? `, ${apply.data.scheduled.length} scheduled` : ''}.`}</p>
      )}
    </div>
  )
}
