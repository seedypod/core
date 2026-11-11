import { Link } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { alertActions } from '@/src/components/Alerts/AlertsPage'
import { CareSummary } from '@/src/components/Care/CareSummary'
import { Button, Card } from '@/src/components/ds/core'
import { useToast } from '@/src/components/ds/toast'
import type { ChoreRow } from '@/src/components/Water/Chores'
import { CHORE_ALERTS } from '@/src/care/engine'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type AlertRow = inferRouterOutputs<AppRouter>['alerts']['list'][number]

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'

/** The alert a reading raises for this chore, if it has one (ADR-0029). */
const alertKind = (id: ChoreRow['id']): string | undefined => CHORE_ALERTS[id as keyof typeof CHORE_ALERTS]

/**
 * The chores that are due, each with its open alert when a reading raised one.
 * One the person skipped stays off until the engine raises it again: a due
 * reading with no open alert may have been skipped, and only then is the
 * history asked whether its last alert was.
 */
export function useNeedsChores(): Array<{ chore: ChoreRow, alert: AlertRow | undefined }> {
  const chores = trpc.care.chores.useQuery(undefined, { refetchInterval: 5 * 60_000 })
  const open = trpc.alerts.list.useQuery({ activeOnly: true })
  const due = (chores.data ?? []).filter(c => c.state === 'due')
  const alertOf = (c: ChoreRow) => (open.data ?? []).find(a => a.kind === alertKind(c.id))
  const unraised = due.some(c => c.basis === 'reading' && alertKind(c.id) && !alertOf(c))
  const history = trpc.alerts.list.useQuery({ activeOnly: false }, { enabled: unraised })
  const skipped = (c: ChoreRow) => {
    const last = alertOf(c) ? undefined : history.data?.find(a => a.kind === alertKind(c.id))
    return !!last?.dismissedAt && !last.active
  }
  return due.filter(c => !skipped(c)).map(c => ({ chore: c, alert: alertOf(c) }))
}

/**
 * Done and Skip, as Alerts does them: with an open alert, Done acknowledges it
 * (which logs the chore in the tank log) and Skip dismisses it; without one,
 * Done logs the tank action itself, as the Chores list does, and can be undone.
 */
export function useChoreActions() {
  const utils = trpc.useUtils()
  const { show } = useToast()
  const doing = useRef<Pick<ChoreRow, 'id' | 'title'> | null>(null)
  const refresh = () => {
    void utils.tank.invalidate()
    void utils.care.invalidate()
  }
  const marked = (undo?: () => void) => {
    const c = doing.current
    if (c) show({ id: `chore-done:${c.id}`, kind: 'success', tone: 'ok', icon: Check, title: `Marked done: ${c.title}`, action: undo && { label: 'Undo', onClick: undo } })
  }
  const undo = trpc.tank.removeAction.useMutation({ onSuccess: refresh })
  const log = trpc.tank.logAction.useMutation({
    onSuccess: (row) => {
      refresh()
      marked(() => undo.mutate({ id: row.id }))
    },
  })
  const ack = trpc.alerts.acknowledge.useMutation({
    onSuccess: () => {
      void utils.alerts.invalidate()
      refresh()
      marked()
    },
  })
  const dismiss = trpc.alerts.dismiss.useMutation({ onSuccess: () => utils.alerts.invalidate() })
  return {
    done: (c: Pick<ChoreRow, 'id' | 'title' | 'doneKind'>, alert?: Pick<AlertRow, 'id'>) => {
      doing.current = c
      if (alert) ack.mutate({ id: alert.id })
      else log.mutate({ kind: c.doneKind, note: '' })
    },
    skip: (alert: Pick<AlertRow, 'id'>) => dismiss.mutate({ id: alert.id }),
    pending: log.isPending || ack.isPending || dismiss.isPending,
    skipped: dismiss.isSuccess,
    error: log.error ?? ack.error ?? dismiss.error,
  }
}

/**
 * A due chore with Done, and Skip when an alert can be skipped: the sidebar's
 * Needs you (`compact`) and the Water page share it, so both read and act the same.
 */
export function ChoreItem({ chore: c, alert, compact = false }: { chore: ChoreRow, alert?: AlertRow, compact?: boolean }) {
  const actions = useChoreActions()
  if (actions.skipped) return null
  const labels = alertActions(alertKind(c.id) ?? `chore_${c.id}`)
  const buttons = (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant={compact ? 'secondary' : 'primary'} icon={Check} disabled={actions.pending} onClick={() => actions.done(c, alert)}>{labels.resolve}</Button>
      {alert && labels.skip && <Button size="sm" icon={X} className="text-fg-2" title="Close it without logging it as done" disabled={actions.pending} onClick={() => actions.skip(alert)}>{labels.skip}</Button>}
    </div>
  )
  return (
    <div
      data-testid={`needs-chore-${c.id}`}
      className={cn('flex gap-2.5', compact ? 'rounded-lg px-2.5 py-2 hover:bg-active/60' : 'border-b border-line px-5 py-3.5 last:border-0')}
    >
      <span className="mt-1.5 size-[7px] shrink-0 rounded-full bg-pod-ready" />
      <div className={cn('flex min-w-0 flex-1 flex-col', compact ? 'gap-1.5' : 'gap-2')}>
        <Link to="/care" className="flex min-w-0 flex-col gap-0.5 hover:text-fg">
          <span className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 text-fg', compact ? 'truncate text-[13px]' : 'text-sm font-medium')}>{c.title}</span>
            {c.basis !== 'reading' && <span className="font-mono text-[10px] uppercase text-fg-3">calendar</span>}
          </span>
          <span className={cn('text-fg-2', compact ? 'truncate text-xs' : 'text-[13px] leading-snug text-pretty')}>{c.reason}</span>
        </Link>
        {buttons}
        {actions.error && <span className="text-xs text-danger">{actions.error.message}</span>}
      </div>
    </div>
  )
}

/** Water's line into Care: the due chores to act on there, else what Care has for now. */
export function DueChores() {
  const items = useNeedsChores()
  if (!items.length) {
    return (
      <Card className="py-3">
        <CareSummary />
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-2.5">
      <h2 className={EYEBROW}>Needs you</h2>
      <Card className="gap-0 p-0" data-testid="due-chores">
        {items.map(i => <ChoreItem key={i.chore.id} chore={i.chore} alert={i.alert} />)}
      </Card>
    </div>
  )
}
