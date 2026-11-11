import { ArrowLeftRight, Shuffle } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type Order = NonNullable<inferRouterOutputs<AppRouter>['vision']['podOrder']>

const pods = (slots: number[]) => `${slots.length === 1 ? 'Pod' : 'Pods'} ${slots.join(', ')}`
const swaps = (s: Array<[number, number]>) => s.map(([a, b]) => `pod ${a} ↔ pod ${b}`).join(', ')

/** The pods out of order, as the Needs you line says it. */
export function orderSummary(order: Order): string {
  return `${pods(order.slots.map(s => s.slot))} don't match their dot codes`
}

/**
 * Pods out of order (#224): where a pod's confirmed dot code says it holds
 * something other than its record or the plan. Two fixes, and nothing changes
 * until the owner picks one: update the records to match the tower (record
 * swaps that keep each plant's sowing date and status), or move the pods to
 * match the plan (a list of swaps to make by hand, then read the codes again).
 */
export function PodOrder() {
  const utils = trpc.useUtils()
  const order = trpc.vision.podOrder.useQuery()
  const [confirming, setConfirming] = useState(false)
  const fix = trpc.vision.fixPodOrder.useMutation({
    onSuccess: () => {
      setConfirming(false)
      void utils.vision.invalidate()
      void utils.grow.invalidate()
    },
  })
  const o = order.data
  if (!o) return null
  return (
    <section id="pod-order" className="flex flex-col gap-3 rounded-[10px] border border-pod-attention/60 p-3" aria-label="Pods out of order">
      <span className="flex items-center gap-1.5 text-[13px] font-medium">
        <Shuffle size={14} className="text-pod-attention" />
        Pods out of order
      </span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
        {o.slots.map(s => (
          <li key={s.slot} data-testid={`order-${s.slot}`}>
            <span className="font-mono text-[11px] text-fg-3">{`Pod ${s.slot}`}</span>
            {` holds ${s.tower} by its code · the record says ${s.record ?? 'nothing'}`}
            {o.plan && ` · the plan says ${s.plan ?? 'nothing'}`}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-1.5" data-testid="fix-records">
        <span className="text-[13px] font-medium">Update the records to match the tower</span>
        {o.recordSwaps.length > 0
          ? <span className="text-xs text-fg-2">{`Swap the records of ${swaps(o.recordSwaps)}. Each plant keeps its sowing date and status.`}</span>
          : <span className="text-xs text-fg-3">No swap of records fixes this.</span>}
        {o.recordsUnresolved.length > 0 && <span className="text-xs text-fg-3">{`${pods(o.recordsUnresolved)}: no other read pod's record has that plant, so these stay as they are.`}</span>}
        {o.recordSwaps.length > 0 && (
          confirming
            ? (
                <span className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="primary" icon={ArrowLeftRight} disabled={fix.isPending} onClick={() => fix.mutate({ key: o.key })}>Yes, update the records</Button>
                  <Button size="sm" disabled={fix.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
                </span>
              )
            : <span><Button size="sm" icon={ArrowLeftRight} onClick={() => setConfirming(true)}>Update records</Button></span>
        )}
      </div>

      <div className="flex flex-col gap-1.5" data-testid="fix-moves">
        <span className="text-[13px] font-medium">{o.plan ? `Move the pods to match ${o.plan.name}` : 'Move the pods to match the plan'}</span>
        {!o.plan
          ? <span className="text-xs text-fg-3">No plan has been applied, so there is nothing to move them to.</span>
          : o.moves.length > 0
            ? <span className="text-xs text-fg-2">{`On the tower, swap ${swaps(o.moves)}, then read the codes again.`}</span>
            : <span className="text-xs text-fg-3">No swap on the tower fixes this.</span>}
        {o.plan && o.movesUnresolved.length > 0 && <span className="text-xs text-fg-3">{`${pods(o.movesUnresolved)}: the plant the plan puts there isn't in another read pod.`}</span>}
      </div>

      {o.unknown > 0 && <span className="text-xs text-fg-3">{`${o.unknown} pod${o.unknown === 1 ? '' : 's'} without a confirmed code ${o.unknown === 1 ? 'is' : 'are'} left alone.`}</span>}
      {fix.error && <InlineError>{fix.error.message}</InlineError>}
    </section>
  )
}
