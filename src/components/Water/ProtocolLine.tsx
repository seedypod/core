import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { nextStage, plainDay } from '@/src/components/Grow/protocolWords'
import { trpc } from '@/src/utils/trpc'

/**
 * The grow protocol in one line (ADR-0030): which one the cycles follow, the
 * stage and day, and when they next change, leading to Grow where it's run.
 */
export function ProtocolLine() {
  const q = trpc.protocol.current.useQuery()
  const r = q.data
  if (!r) return null
  const stage = r.stages.find(s => s.id === r.stage)
  const next = nextStage(r)
  const parts = !r.following
    ? [`Not following ${r.protocol.name}`, 'the cycles stay as they are']
    : !stage || r.dayInStage === null
        ? [`${r.protocol.name} protocol`, 'starts when pods are planted']
        : [
            `Following ${r.protocol.name}`,
            `${stage.name}, day ${r.dayInStage + 1}`,
            r.water === 'schedule' ? 'on your schedule' : r.water === 'edited' ? 'cycles changed by hand, left as they are' : r.hold ? 'held' : next?.startsOn ? `next change ${plainDay(next.startsOn)}` : 'ongoing',
          ]
  return (
    <Link to="/grow" data-testid="protocol-line" className="flex w-fit max-w-full items-center gap-1 text-[13px] text-fg-2 hover:text-fg">
      <span className="min-w-0">{parts.join(' · ')}</span>
      <ChevronRight size={14} aria-hidden className="shrink-0" />
    </Link>
  )
}
