import { ArrowLeftRight } from 'lucide-react'
import { Button } from '@/src/components/ds/core'

interface Props {
  moves: { from: number, to: number, text: string }[]
  /** Carry one out: the pods swap, as a drag from `from` onto `to` would. */
  onApply: (from: number, to: number) => void
}

/** Moves for planted pods the planner rates clearly better, all optional: after moving the yCubes, one tap moves their records too. */
export function SuggestedMoves({ moves, onApply }: Props) {
  if (moves.length === 0) return null
  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-[var(--radius-ctl)] border border-line px-3 py-2">
      <div className="text-[12px] text-fg-3">Suggested moves · optional, once you move the yCubes</div>
      <ul aria-label="Suggested moves" className="flex flex-col gap-1.5">
        {moves.map(m => (
          <li key={`${m.from}-${m.to}`} className="flex items-center gap-2 text-[13px] text-fg-2">
            <span className="min-w-0 flex-1">{m.text}</span>
            <Button size="sm" icon={ArrowLeftRight} aria-label={`Moved pod ${m.from} to pod ${m.to}`} onClick={() => onApply(m.from, m.to)}>Moved</Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
