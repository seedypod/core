import { Leaf, Sprout } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, KeyValue } from '@/src/components/ds/core'
import { SegmentedControl, SelectValue, TextField } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'
import { LineChart } from '@/src/components/ds/charts'
import { ageDays } from './towerLayout'
import { TowerView } from './TowerView'

type Stage = 'germination' | 'seedling' | 'vegetative' | 'harvest'
type PodStatus = 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention'
const STAGES: { value: Stage, label: string }[] = [{ value: 'germination', label: 'Germination' }, { value: 'seedling', label: 'Seedling' }, { value: 'vegetative', label: 'Vegetative' }, { value: 'harvest', label: 'Harvest' }]
const STATUS: { value: PodStatus, label: string }[] = [{ value: 'empty', label: 'Empty' }, { value: 'seeded', label: 'Seeded' }, { value: 'growing', label: 'Growing' }, { value: 'harvest', label: 'Harvest' }, { value: 'attention', label: 'Attention' }]
const TREND: Record<string, string> = { growing: 'growing', stalled: 'stalled', declining: 'shrinking', unknown: 'not enough photos yet' }
type View = 'tower' | 'table'
const VIEW_KEY = 'seedypod.growView'

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tower' ? 'tower' : 'table'
  }
  catch {
    return 'table'
  }
}

const POD_CLASS: Record<PodStatus, string> = {
  empty: 'bg-field border-line text-fg-3',
  seeded: 'bg-active border-line-2 text-fg-2',
  growing: 'bg-[color-mix(in_oklab,var(--pod-ok)_18%,transparent)] border-[var(--pod-ok)] text-fg',
  harvest: 'bg-[color-mix(in_oklab,var(--accent-light)_22%,transparent)] border-[var(--accent-light)] text-fg',
  attention: 'bg-[color-mix(in_oklab,var(--pod-attention)_22%,transparent)] border-[var(--pod-attention)] text-fg',
}

interface Draft { slot: number, plant: string, status: PodStatus, notes: string }

/**
 * The tower (or the table) takes two thirds of the width; the cycle and the
 * selected pod sit in the right column. On a phone they stack: cycle, tower, pod.
 */
export function GrowPage() {
  const utils = trpc.useUtils()
  const grow = trpc.grow.current.useQuery()
  const pods = trpc.grow.pods.useQuery()
  const start = trpc.grow.start.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const end = trpc.grow.end.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const setStage = trpc.grow.setStage.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const updatePod = trpc.grow.updatePod.useMutation({ onSuccess: () => utils.grow.pods.invalidate() })
  const trends = trpc.vision.podTrends.useQuery()
  const sensors = trpc.sensors.latest.useQuery()
  const light = trpc.light.get.useQuery()
  const [edited, setDraft] = useState<Draft | null>(null)
  // `?pod=N` (from Home) opens that pod until another is picked.
  const [linked] = useState(() => {
    const n = Number(new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('pod'))
    return Number.isInteger(n) && n > 0 ? n : null
  })
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
  const all = pods.data ?? []
  const draftOf = (slot: number): Draft | null => {
    const p = all.find(x => x.slot === slot)
    return p ? { slot: p.slot, plant: p.plant ?? '', status: p.status, notes: p.notes } : null
  }
  const select = (slot: number) => setDraft(draftOf(slot))
  const draft = edited ?? (linked === null ? null : draftOf(linked))
  const trendBySlot = new Map((trends.data ?? []).map(t => [t.slot, t]))
  const towerPods = all.map(p => ({ slot: p.slot, status: p.status, plant: p.plant, green: trendBySlot.get(p.slot)?.green ?? null, ageDays: ageDays(p.plantedAt) }))
  const shown: View = noWebGL ? 'table' : view
  const cycle = grow.data?.cycle
  const counts = all.reduce<Record<string, number>>((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {})
  const saved = draft ? all.find(p => p.slot === draft.slot) : undefined
  const dirty = !!draft && !!saved && (draft.plant !== (saved.plant ?? '') || draft.status !== saved.status || draft.notes !== saved.notes)
  const trend = draft ? trendBySlot.get(draft.slot) : undefined

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-4">
      <PageHeader
        title="Grow"
        right={!noWebGL && <SegmentedControl<View> size="sm" ariaLabel="Pod view" value={shown} options={[{ value: 'table', label: 'Table' }, { value: 'tower', label: 'Tower' }]} onChange={chooseView} />}
      />
      <div className="grid gap-4 [grid-template-areas:'cycle'_'pods'_'pod'] min-[900px]:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] min-[900px]:grid-rows-[auto_1fr] min-[900px]:[grid-template-areas:'pods_cycle'_'pods_pod']">
        <Card className="[grid-area:cycle]">
          <CardHeader
            title={cycle ? `Day ${grow.data?.day}` : 'No active cycle'}
            subtitle={cycle ? `started ${new Date(cycle.startedAt).toLocaleDateString()}${cycle.notes ? ` · ${cycle.notes}` : ''}` : 'Start a cycle to get thinning, root-check, harvest and nutrient reminders.'}
            icon={Leaf}
            right={cycle ? <Button size="sm" onClick={() => end.mutate()}>End cycle</Button> : <Button size="sm" variant="primary" onClick={() => start.mutate({ notes: '' })}>Start cycle</Button>}
          />
          {cycle && cycle.stage !== 'ended' && (
            <div className="mt-3 flex items-center justify-between gap-3 text-sm text-fg-2">
              Stage
              <SelectValue<Stage> label="Stage" value={cycle.stage as Stage} options={STAGES} onChange={stage => setStage.mutate({ stage })} />
            </div>
          )}
          <p className="mt-3 font-mono text-[11px] text-fg-3" data-testid="pod-counts">
            {`${counts.growing ?? 0} growing · ${counts.harvest ?? 0} ready · ${counts.attention ?? 0} attention · ${counts.empty ?? 0} empty`}
          </p>
        </Card>

        <div className="min-w-0 [grid-area:pods]">
          {shown === 'tower' && (
            <TowerView
              pods={towerPods}
              waterPct={sensors.data?.water_level_pct?.value ?? null}
              lightLevel={light.data?.on ? light.data.level : 0}
              selected={draft?.slot ?? null}
              onSelect={select}
              onUnavailable={() => setNoWebGL(true)}
            />
          )}
          {noWebGL && <p className="mb-2 text-xs text-fg-3">The 3D tower needs WebGL, which this browser doesn&apos;t offer, so the pods are shown as a table.</p>}
          {shown === 'table' && (
            <div className="grid grid-cols-2 gap-2 min-[600px]:grid-cols-3 min-[1100px]:grid-cols-5" aria-label="Pods">
              {all.map((p) => {
                const t = trendBySlot.get(p.slot)
                const age = ageDays(p.plantedAt)
                return (
                  <button
                    key={p.slot}
                    type="button"
                    onClick={() => select(p.slot)}
                    aria-pressed={draft?.slot === p.slot}
                    aria-label={`${p.slot} ${p.plant ?? 'empty'}`}
                    className={cn('flex min-h-[92px] flex-col gap-1 rounded-[var(--radius-ctl)] border p-2 text-left', POD_CLASS[p.status], draft?.slot === p.slot && 'outline outline-2 outline-offset-2 outline-[var(--text-1)]')}
                  >
                    <span className="flex items-baseline justify-between gap-1 font-mono text-[10px] opacity-70">
                      <span>{p.slot}</span>
                      {age !== null && p.status !== 'empty' && <span>{`d${Math.floor(age)}`}</span>}
                    </span>
                    <span className="line-clamp-2 text-[12px] leading-tight">{p.plant ?? (p.status === 'empty' ? 'Empty' : '')}</span>
                    {t && t.recent.length > 1 && p.status !== 'empty' && (
                      <span className="mt-auto flex items-end gap-1.5">
                        <span className="min-w-0 flex-1"><LineChart series={[{ data: t.recent, color: 'var(--status-ok)', width: 1.25 }]} height={18} /></span>
                        <span className="font-mono text-[10px] text-fg-2">{`${Math.round((t.green ?? 0) * 100)}%`}</span>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <Card className="self-start [grid-area:pod]">
          <CardHeader
            title={draft ? `Pod ${draft.slot}` : 'Pods'}
            subtitle={draft ? saved?.plant ?? 'Empty' : `Click a pod ${shown === 'tower' ? 'on the tower' : 'in the table'} to see and edit it.`}
            icon={Sprout}
          />
          {all.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-fg-2">
              Pod
              <SelectValue<number>
                label="Pod"
                value={draft?.slot ?? 0}
                options={[...(draft ? [] : [{ value: 0, label: 'Pick…' }]), ...all.map(p => ({ value: p.slot, label: `${p.slot}${p.plant ? ` · ${p.plant}` : ''}` }))]}
                onChange={slot => slot && select(slot)}
              />
            </div>
          )}
          {draft && (
            <div className="mt-3 flex flex-col gap-3">
              <TextField label="Plant" mono={false} value={draft.plant} onChange={v => setDraft({ ...draft, plant: v })} placeholder="e.g. Genovese Basil" />
              <div className="flex items-center justify-between gap-3 text-xs text-fg-2">
                Status
                <SelectValue<PodStatus> label="Status" value={draft.status} options={STATUS} onChange={status => setDraft({ ...draft, status })} />
              </div>
              <TextField label="Notes" mono={false} value={draft.notes} onChange={v => setDraft({ ...draft, notes: v })} />
              <KeyValue label="Planted" value={saved?.plantedAt ?? '—'} />
              <KeyValue label="Green area" value={typeof trend?.green === 'number' ? `${Math.round(trend.green * 100)}% · ${TREND[trend.verdict] ?? trend.verdict}` : '—'} />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={!dirty || updatePod.isPending}
                  onClick={() => updatePod.mutate({ slot: draft.slot, plant: draft.plant || null, status: draft.status, notes: draft.notes, plantedAt: draft.status === 'seeded' && saved?.status !== 'seeded' ? new Date().toISOString().slice(0, 10) : undefined })}
                >
                  Save
                </Button>
                <Button disabled={!dirty} onClick={() => select(draft.slot)}>Revert</Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
