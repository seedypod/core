import { Link } from '@tanstack/react-router'
import { ChevronRight, ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'

/** "Top off and Feed due · 1 setup issue": what Care has for now, as one line, and how urgent it is. */
export function careLine(chores: readonly { title: string, state: string }[], issues: number): { text: string, tone: 'due' | 'soon' | 'ok' } {
  const due = chores.filter(c => c.state === 'due').map(c => c.title)
  const soon = chores.filter(c => c.state === 'soon').map(c => c.title)
  const list = (t: string[]) => (t.length > 2 ? `${t.slice(0, 2).join(', ')} +${t.length - 2}` : t.join(' and '))
  const parts = [
    due.length ? `${list(due)} due` : soon.length ? `${list(soon)} soon` : 'Nothing due',
    ...(issues ? [`${issues} setup issue${issues > 1 ? 's' : ''}`] : []),
  ]
  return { text: parts.join(' · '), tone: due.length || issues ? 'due' : soon.length ? 'soon' : 'ok' }
}

const TONE = { due: 'bg-pod-attention', soon: 'bg-pod-ready', ok: 'bg-pod-ok' } as const

/** Home's line into Care (ADR-0029): what's due now and any setup issue, linking to the context. `chores`, a list already narrowed (skipped ones left out). */
export function CareSummary({ className, chores: given }: { className?: string, chores?: readonly { title: string, state: string }[] }) {
  const chores = trpc.care.chores.useQuery(undefined, { refetchInterval: 5 * 60_000 })
  const setup = trpc.care.setup.useQuery(undefined, { refetchInterval: 5 * 60_000 })
  if (!chores.data || !setup.data) return null
  const { text, tone } = careLine(given ?? chores.data, setup.data.issues.length)
  return (
    <Link to="/care" data-testid="care-summary" className={cn('flex items-center gap-2 text-[13px] text-fg-2 hover:text-fg', className)}>
      <ListChecks size={15} strokeWidth={1.75} className="shrink-0" />
      <span className={cn('size-[7px] shrink-0 rounded-full', TONE[tone])} />
      <span className="min-w-0 truncate">{text}</span>
      <ChevronRight size={14} className="shrink-0 text-fg-3" />
    </Link>
  )
}
