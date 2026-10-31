import { Leaf } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, KeyValue, SectionLabel } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, TextField } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'

type Stage = 'germination' | 'seedling' | 'vegetative' | 'harvest'
type PodStatus = 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention'
const STAGES: { value: Stage, label: string }[] = [{ value: 'germination', label: 'Germination' }, { value: 'seedling', label: 'Seedling' }, { value: 'vegetative', label: 'Vegetative' }, { value: 'harvest', label: 'Harvest' }]
const STATUS: { value: PodStatus, label: string }[] = [{ value: 'empty', label: 'Empty' }, { value: 'seeded', label: 'Seeded' }, { value: 'growing', label: 'Growing' }, { value: 'harvest', label: 'Harvest' }, { value: 'attention', label: 'Attention' }]
const POD_CLASS: Record<PodStatus, string> = {
  empty: 'bg-field border-line text-fg-3',
  seeded: 'bg-active border-line-2 text-fg-2',
  growing: 'bg-[color-mix(in_oklab,var(--pod-ok)_18%,transparent)] border-[var(--pod-ok)] text-fg',
  harvest: 'bg-[color-mix(in_oklab,var(--accent-light)_22%,transparent)] border-[var(--accent-light)] text-fg',
  attention: 'bg-[color-mix(in_oklab,var(--pod-attention)_22%,transparent)] border-[var(--pod-attention)] text-fg',
}

export function GrowPage() {
  const utils = trpc.useUtils()
  const grow = trpc.grow.current.useQuery()
  const pods = trpc.grow.pods.useQuery()
  const start = trpc.grow.start.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const end = trpc.grow.end.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const setStage = trpc.grow.setStage.useMutation({ onSuccess: () => utils.grow.invalidate() })
  const updatePod = trpc.grow.updatePod.useMutation({ onSuccess: () => utils.grow.pods.invalidate() })
  const [editing, setEditing] = useState<{ slot: number, plant: string, status: PodStatus, notes: string } | null>(null)
  const cycle = grow.data?.cycle
  const counts = (pods.data ?? []).reduce<Record<string, number>>((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {})

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Grow" />
      <Card>
        <CardHeader
          title={cycle ? `Day ${grow.data?.day}` : 'No active cycle'}
          subtitle={cycle ? `started ${new Date(cycle.startedAt).toLocaleDateString()}${cycle.notes ? ` · ${cycle.notes}` : ''}` : 'Start a cycle to get thinning, root-check, harvest and nutrient reminders.'}
          icon={Leaf}
          right={cycle ? <Button size="sm" onClick={() => end.mutate()}>End cycle</Button> : <Button size="sm" variant="primary" onClick={() => start.mutate({ notes: '' })}>Start cycle</Button>}
        />
        {cycle && cycle.stage !== 'ended' && (
          <div className="mt-3"><SegmentedControl<Stage> full value={cycle.stage as Stage} options={STAGES} onChange={stage => setStage.mutate({ stage })} /></div>
        )}
      </Card>

      <SectionLabel right={(
        <span className="font-mono text-[11px] text-fg-3">
          {counts.growing ?? 0}
          {' '}
          growing ·
          {' '}
          {counts.harvest ?? 0}
          {' '}
          ready ·
          {' '}
          {counts.attention ?? 0}
          {' '}
          attention
        </span>
      )}
      >
        Pods
      </SectionLabel>
      <div className="grid grid-cols-5 gap-2 min-[600px]:grid-cols-6 min-[900px]:grid-cols-10">
        {(pods.data ?? []).map(p => (
          <button
            key={p.slot}
            type="button"
            onClick={() => setEditing({ slot: p.slot, plant: p.plant ?? '', status: p.status, notes: p.notes })}
            className={cn('flex aspect-square flex-col items-center justify-center rounded-[var(--radius-ctl)] border p-1 text-center', POD_CLASS[p.status])}
            title={p.plant ?? 'empty'}
          >
            <span className="font-mono text-[10px] opacity-70">{p.slot}</span>
            <span className="line-clamp-2 text-[10px] leading-tight">{p.plant ?? ''}</span>
          </button>
        ))}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Pod ${editing?.slot ?? ''}`}
        icon={Leaf}
        footer={editing && (
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                updatePod.mutate({ slot: editing.slot, plant: editing.plant || null, status: editing.status, notes: editing.notes, plantedAt: editing.status === 'seeded' ? new Date().toISOString().slice(0, 10) : undefined })
                setEditing(null)
              }}
            >
              Save
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        )}
      >
        {editing && (
          <div className="flex flex-col gap-4">
            <TextField label="Plant" mono={false} value={editing.plant} onChange={v => setEditing({ ...editing, plant: v })} placeholder="e.g. Genovese Basil" />
            <div className="flex flex-col gap-1.5 text-xs text-fg-2">
              Status
              <SegmentedControl<PodStatus> full size="sm" value={editing.status} options={STATUS} onChange={status => setEditing({ ...editing, status })} />
            </div>
            <TextField label="Notes" mono={false} value={editing.notes} onChange={v => setEditing({ ...editing, notes: v })} />
            <KeyValue label="Planted" value={(pods.data ?? []).find(p => p.slot === editing.slot)?.plantedAt ?? '—'} />
          </div>
        )}
      </Modal>
    </div>
  )
}
