import { EyeOff } from 'lucide-react'
import { useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { trpc } from '@/src/utils/trpc'

const pods = (slots: number[]) => `${slots.length === 1 ? 'pod' : 'pods'} ${slots.join(', ')}`

/** Pods the cameras see empty that the layout still counts as planted, with one confirmed step to mark them empty so the plan can use them. */
export function SeenEmpty({ slots }: { slots: number[] }) {
  const utils = trpc.useUtils()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = trpc.grow.updatePod.useMutation()
  if (slots.length === 0) return null
  const clear = async () => {
    setPending(true)
    setError(null)
    try {
      await Promise.all(slots.map(slot => update.mutateAsync({ slot, plant: null, plantedAt: null, status: 'empty', notes: '' })))
      setConfirming(false)
    }
    catch (e) {
      setError((e as Error).message)
    }
    finally {
      setPending(false)
      void utils.grow.invalidate()
      void utils.planner.invalidate()
      void utils.vision.seenEmpty.invalidate()
    }
  }
  return (
    <div role="status" aria-label="Pods seen empty" className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-ctl)] border border-line px-3 py-2 text-[13px] text-fg-2">
      <EyeOff size={14} aria-hidden="true" className="shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1">{confirming ? `Mark ${pods(slots)} empty?` : `Cameras see ${pods(slots)} empty.`}</span>
      {confirming
        ? (
            <span className="flex gap-1.5">
              <Button size="sm" variant="primary" disabled={pending} onClick={() => void clear()}>Yes, mark empty</Button>
              <Button size="sm" disabled={pending} onClick={() => setConfirming(false)}>Cancel</Button>
            </span>
          )
        : <Button size="sm" onClick={() => setConfirming(true)}>Mark empty</Button>}
      {error && <InlineError className="w-full">{error}</InlineError>}
    </div>
  )
}
