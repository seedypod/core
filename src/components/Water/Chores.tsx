import { Check } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { cn } from '@/lib/utils'
import { useChoreActions, useChoreAlerts } from '@/src/components/Care/ChoreItem'
import { Button, Card, InlineError } from '@/src/components/ds/core'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

export type ChoreRow = inferRouterOutputs<AppRouter>['care']['chores'][number]

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
const RANK: Record<ChoreRow['state'], number> = { due: 0, soon: 1, unknown: 2, ok: 3 }
const STATE: Record<ChoreRow['state'], { label: string, cls: string }> = {
  due: { label: 'due', cls: 'bg-pod-attention/15 text-pod-attention' },
  soon: { label: 'soon', cls: 'bg-pod-ready/15 text-pod-ready' },
  ok: { label: 'ok', cls: 'bg-pod-ok/15 text-pod-ok' },
  unknown: { label: 'unknown', cls: 'bg-active text-fg-3' },
}

/** Due first, then soon, then the rest, keeping the engine's order within each. */
export const byUrgency = (rows: readonly ChoreRow[]): ChoreRow[] => [...rows].sort((a, b) => RANK[a.state] - RANK[b.state])

/**
 * Chores (ADR-0029), each from a reading the unit trusts or a stated calendar
 * guess, with the knowledge notes behind its numbers. Done logs it in the tank
 * log, which is what the chore counts from, as Needs you does (useChoreActions).
 */
export function Chores() {
  const list = trpc.care.chores.useQuery(undefined, { refetchInterval: 5 * 60_000 })
  const actions = useChoreActions()
  const { ready, alertOf } = useChoreAlerts()
  const rows = byUrgency(list.data ?? [])
  return (
    <div className="flex flex-col gap-2.5" id="chores">
      <h2 className={EYEBROW}>Chores</h2>
      <Card className="gap-0 p-0" data-testid="chores">
        {rows.length === 0 && <p className="px-5 py-3 text-[13px] text-fg-3">Working out what the tower needs…</p>}
        {rows.map(c => (
          <div key={c.id} data-testid={`chore-${c.id}`} className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line px-5 py-3.5 last:border-0">
            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{c.title}</span>
                <span className={cn('rounded-[10px] px-2 py-0.5 font-mono text-[10px] font-medium uppercase', STATE[c.state].cls)}>{STATE[c.state].label}</span>
                <span className="font-mono text-[10px] uppercase text-fg-3">{c.basis === 'reading' ? 'from a reading' : 'calendar'}</span>
              </div>
              <span className="text-[13px] leading-snug text-fg-2 text-pretty">{c.reason}</span>
              {c.citations.length > 0 && (
                <span className="flex flex-wrap gap-x-3 text-[12px] text-fg-3">
                  {c.citations.map(s => (
                    <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">{s.section}</a>
                  ))}
                </span>
              )}
            </div>
            {(c.state === 'due' || c.state === 'soon') && (
              <Button icon={Check} className="px-3 py-[7px]" disabled={!ready || actions.busy(c.id)} onClick={() => actions.done(c, alertOf(c))}>Done</Button>
            )}
          </div>
        ))}
      </Card>
      {actions.error && <InlineError>{actions.error.message}</InlineError>}
    </div>
  )
}
