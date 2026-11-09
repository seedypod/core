import { FolderOpen, LayoutGrid, Sprout, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PlantThumb } from '@/src/components/Grow/PlantThumb'
import { PLANNED_FORM } from '@/src/components/Grow/towerLayout'
import { Badge, Button, Card, GhostIcon } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { applyPreview, planChips, planMeta, plantNames, shortDate, type PlanChip, type SavedPlan } from './planSummary'

/** How long a deleted plan can be brought back before it is removed for good. */
export const UNDO_MS = 6000

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function Chip({ chip }: { chip: PlanChip }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5 rounded-full border border-line py-0.5 pl-0.5 pr-2.5 text-[12px] text-fg">
      <PlantThumb plant={chip.name} stage={PLANNED_FORM} size={22} />
      <span className="truncate">{chip.name}</span>
      {chip.count > 1 && <span className="font-mono text-[11px] text-fg-3">{`×${chip.count}`}</span>}
    </li>
  )
}

/** One saved plan: its plants as pictured chips, how it fills the tower, and what to do with it. */
function PlanCard({ plan, names, editing, onOpen, onApply, onDelete }: { plan: SavedPlan, names: Map<string, string>, editing: boolean, onOpen: () => void, onApply: () => void, onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const { shown, hidden } = planChips(plan, names)
  const meta = planMeta(plan)
  return (
    <Card highlight={!!plan.appliedAt} data-testid="plan-card" aria-label={plan.name} role="group">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-[15px] font-medium">{plan.name}</span>
            {plan.appliedAt && <Badge variant="active">applied</Badge>}
            {editing && <Badge>editing</Badge>}
          </div>
          <div data-testid="plan-meta" className="mt-0.5 flex flex-wrap gap-x-1.5 text-[12px] text-fg-2">
            <span>{meta.model}</span>
            <span aria-hidden="true">·</span>
            <span>{`${meta.placed} of ${meta.capacity} pods`}</span>
            {meta.unplaced > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-warn">{`${meta.unplaced} unplaced`}</span>
              </>
            )}
            {meta.when && (
              <>
                <span aria-hidden="true">·</span>
                <span title={new Date(meta.when.at).toLocaleString()}>{`${meta.when.verb} ${shortDate(meta.when.at)}`}</span>
              </>
            )}
          </div>
        </div>
        <GhostIcon icon={Trash2} label={`Delete ${plan.name}`} onClick={onDelete} className="-mr-2 -mt-1" />
      </div>
      <ul aria-label={`Plants in ${plan.name}`} className="flex flex-wrap gap-1.5">
        {[...shown, ...(expanded ? hidden : [])].map(c => <Chip key={c.plantId} chip={c} />)}
        {hidden.length > 0 && (
          <li>
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="rounded-full border border-dashed border-line-2 px-2.5 py-1 text-[12px] text-fg-2 hover:bg-active hover:text-fg">
              {expanded ? 'Show fewer' : `+${hidden.length} more`}
            </button>
          </li>
        )}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={FolderOpen} onClick={onOpen}>Open in planner</Button>
        <Button size="sm" icon={Sprout} onClick={onApply}>Apply to tower</Button>
      </div>
    </Card>
  )
}

/**
 * The saved plans as cards. Open loads one into the planner above; Apply asks
 * first, saying what applying writes; Delete hides the card at once with an
 * Undo, and removes the plan once that lapses (or the page closes).
 */
export function SavedPlans<P extends SavedPlan>({ plans, catalog, editing, onOpen, onApply, onRemove, now = () => new Date() }: {
  plans: P[]
  catalog: { id: string, name: string }[]
  editing: string | null
  onOpen: (plan: P) => void
  onApply: (id: string) => void
  onRemove: (id: string) => void
  now?: () => Date
}) {
  const [confirm, setConfirm] = useState<P | null>(null)
  const [deleted, setDeleted] = useState<string[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const remove = useRef(onRemove)
  useEffect(() => {
    remove.current = onRemove
  }, [onRemove])
  // Leaving the page doesn't undo a delete: anything still waiting goes now.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const [id, t] of pending) {
        clearTimeout(t)
        remove.current(id)
      }
      pending.clear()
    }
  }, [])

  const drop = (id: string) => {
    setDeleted(d => [...d, id])
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id)
      remove.current(id)
      setDeleted(d => d.filter(x => x !== id))
    }, UNDO_MS))
  }
  const undo = (id: string) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setDeleted(d => d.filter(x => x !== id))
  }

  const gone = new Set(deleted)
  const today = now().toISOString().slice(0, 10)
  const preview = confirm ? applyPreview(confirm, today) : null
  const unplaced = confirm?.layout.unplaced.length ?? 0
  return (
    <>
      {plans.length === 0 && <Card dashed><p className="text-[13px] text-fg-2">Pick plants above, then save a plan. Applying it writes the layout onto your pods and schedules reminders for later waves.</p></Card>}
      {plans.map(p => gone.has(p.id)
        ? (
            <Card key={p.id} flat dashed role="status" className="flex-row items-center justify-between py-2.5">
              <span className="min-w-0 truncate text-[13px] text-fg-2">{`Deleted “${p.name}”`}</span>
              <Button size="sm" variant="ghost" onClick={() => undo(p.id)}>Undo</Button>
            </Card>
          )
        : <PlanCard key={p.id} plan={p} names={plantNames(p, catalog)} editing={editing === p.id} onOpen={() => onOpen(p)} onApply={() => setConfirm(p)} onDelete={() => drop(p.id)} />)}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? `Apply “${confirm.name}” to your tower?` : ''}
        icon={LayoutGrid}
        footer={(
          <div className="flex gap-2">
            <Button
              variant="primary"
              icon={Sprout}
              onClick={() => {
                if (confirm) onApply(confirm.id)
                setConfirm(null)
              }}
            >
              Apply to tower
            </Button>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        )}
      >
        {confirm && preview && (
          <div className="flex flex-col gap-2 text-[13px] text-fg-2">
            <p>This writes the plan onto your pods:</p>
            <ul className="list-disc pl-5">
              {preview.now > 0 && <li>{`${plural(preview.now, 'pod')} marked seeded today.`}</li>}
              {preview.later > 0 && <li>{`${plural(preview.later, 'pod')} kept for a later wave with ${preview.later === 1 ? 'its' : 'their'} sow date; you’ll get a reminder when each is due${preview.nextSow ? ` (next ${shortDate(preview.nextSow)})` : ''}.`}</li>}
              <li>Pods the plan uses lose what they hold now; the rest stay as they are.</li>
              {unplaced > 0 && <li className="text-warn">{`${plural(unplaced, 'pod')} that didn’t fit ${unplaced === 1 ? 'is' : 'are'} left out.`}</li>}
              <li>A grow cycle starts if none is running.</li>
            </ul>
          </div>
        )}
      </Modal>
    </>
  )
}
