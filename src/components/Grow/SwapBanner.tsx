import { ArrowLeftRight } from 'lucide-react'
import { Button } from '@/src/components/ds/core'

/** Asks for the pod to swap `slot` with, while a swap is being picked; Cancel lets go of it. */
export function SwapBanner({ slot, plant, onCancel }: { slot: number, plant: string | null | undefined, onCancel: () => void }) {
  return (
    <div data-testid="swap-banner" className="mb-2.5 flex flex-wrap items-center gap-2 rounded-[10px] border border-line-2 bg-active/60 px-3 py-2 text-[13px]">
      <ArrowLeftRight size={16} className="shrink-0 text-fg-2" />
      <span className="flex-1">{`Pick the pod to swap pod ${slot}${plant ? ` (${plant})` : ''} with.`}</span>
      <Button className="px-3 py-[5px] text-[13px]" onClick={onCancel}>Cancel</Button>
    </div>
  )
}
