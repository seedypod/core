import { Link } from '@tanstack/react-router'
import { Check, ChevronRight, TriangleAlert, X } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState, useSyncExternalStore } from 'react'
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

/** Each chore's open alert, and whether the open alerts have loaded: until then Done can't tell which way to go. */
export function useChoreAlerts(): { ready: boolean, alertOf: (c: Pick<ChoreRow, 'id'>) => AlertRow | undefined } {
  const open = trpc.alerts.list.useQuery({ activeOnly: true })
  return { ready: open.data !== undefined, alertOf: c => open.data?.find(a => a.kind === alertKind(c.id)) }
}

/**
 * The chores, less any the person skipped, and the due ones among them, each
 * with its open alert when a reading raised one. A skipped chore stays off
 * until the engine raises it again: a due reading with no open alert may have
 * been skipped, and only for those is the alert's last row asked for. Calendar
 * chores have no alert, so old history never hides one. `ready` once the open
 * alerts and those last rows are in.
 */
export function useNeedsChores(): { items: Array<{ chore: ChoreRow, alert: AlertRow | undefined }>, chores: ChoreRow[], ready: boolean } {
  const list = trpc.care.chores.useQuery(undefined, { refetchInterval: 5 * 60_000 })
  const { ready, alertOf } = useChoreAlerts()
  const all = list.data ?? []
  const unraised = ready ? all.flatMap(c => (c.state === 'due' && c.basis === 'reading' && !alertOf(c) ? [{ chore: c, kind: alertKind(c.id) }] : [])).filter((u): u is { chore: ChoreRow, kind: string } => !!u.kind) : []
  const last = trpc.useQueries(t => unraised.map(u => t.alerts.list({ activeOnly: false, kind: u.kind, limit: 1 })))
  const hidden = new Set(unraised.filter((_, i) => {
    const row = last[i]?.data?.[0]
    return !!row?.dismissedAt && !row.active
  }).map(u => u.chore.id))
  const chores = all.filter(c => !hidden.has(c.id))
  return {
    items: chores.filter(c => c.state === 'due').map(c => ({ chore: c, alert: alertOf(c) })),
    chores,
    ready: ready && last.every(q => q.data !== undefined),
  }
}

/**
 * The chores being marked done anywhere on the page, from Done until the lists
 * have refetched: the sidebar, Water and Care can each show the same chore, and
 * none may log it twice.
 */
const completing = (() => {
  const ids = new Set<string>()
  const listeners = new Set<() => void>()
  let version = 0
  const changed = () => {
    version += 1
    for (const l of listeners) l()
  }
  return {
    has: (id: string) => ids.has(id),
    start: (id: string) => {
      if (ids.has(id)) return false
      ids.add(id)
      changed()
      return true
    },
    end: (id: string) => {
      if (ids.delete(id)) changed()
    },
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    version: () => version,
  }
})()

/**
 * Done and Skip, as Alerts does them: with an open alert, Done acknowledges it
 * (which logs the chore in the tank log) and Skip dismisses it; without one,
 * Done logs the tank action itself and can be undone. "Marked done" only once
 * something was logged: an alert already cleared by the time Done lands logs
 * nothing, so the lists just refetch. A chore stays busy everywhere until the
 * refetch is in, so a row that hasn't caught up can't log it again. Undo and
 * its Retry go through the plain client, so they work after the row is gone.
 */
export function useChoreActions() {
  const utils = trpc.useUtils()
  const { show } = useToast()
  const [skippedId, setSkippedId] = useState<number | null>(null)
  useSyncExternalStore(completing.subscribe, completing.version)
  const log = trpc.tank.logAction.useMutation()
  const ack = trpc.alerts.acknowledge.useMutation()
  const dismiss = trpc.alerts.dismiss.useMutation({
    onSuccess: (row) => {
      if (row) setSkippedId(row.id)
      void utils.alerts.invalidate()
    },
  })
  const settle = () => Promise.all([utils.tank.invalidate(), utils.care.invalidate(), utils.alerts.invalidate()])
  const marked = (c: Pick<ChoreRow, 'id' | 'title'>, undo?: () => void) => show({ id: `chore-done:${c.id}`, kind: 'success', tone: 'ok', icon: Check, title: `Marked done: ${c.title}`, action: undo && { label: 'Undo', onClick: undo } })
  const undo = (c: Pick<ChoreRow, 'id' | 'title'>, id: number) => {
    utils.client.tank.removeAction.mutate({ id })
      .then(settle)
      .catch((e: Error) => show({ id: `chore-undo:${c.id}`, kind: 'info', tone: 'danger', icon: TriangleAlert, title: `Couldn't undo: ${c.title}`, detail: e.message, action: { label: 'Retry', onClick: () => undo(c, id) } }))
  }
  const complete = async (c: Pick<ChoreRow, 'id' | 'title' | 'doneKind'>, alert?: Pick<AlertRow, 'id'>) => {
    if (!completing.start(c.id)) return
    try {
      if (alert) {
        const row = await ack.mutateAsync({ id: alert.id })
        // The router clears an open alert as it acknowledges it, both at the same instant, and only then logs the chore.
        if (row?.acknowledgedAt && row.clearedAt === row.acknowledgedAt) marked(c)
      }
      else {
        const row = await log.mutateAsync({ kind: c.doneKind, note: '' })
        marked(c, () => undo(c, row.id))
      }
      await settle()
    }
    catch {
      // The mutation's error says why, under the row.
    }
    finally {
      completing.end(c.id)
    }
  }
  return {
    done: (c: Pick<ChoreRow, 'id' | 'title' | 'doneKind'>, alert?: Pick<AlertRow, 'id'>) => {
      void complete(c, alert)
    },
    skip: (alert: Pick<AlertRow, 'id'>) => dismiss.mutate({ id: alert.id }),
    /** This chore is being marked done here or in another row, or a Skip is in flight. */
    busy: (id: string) => completing.has(id) || dismiss.isPending,
    /** The alert last skipped from here; a new one for the same chore shows it again. */
    skippedId,
    error: log.error ?? ack.error ?? dismiss.error,
  }
}

/**
 * A due chore with Done, and Skip when an alert can be skipped: the sidebar's
 * Needs you (`compact`) and the Water page share it, so both read and act the
 * same. `disabled` until it's known whether the chore has an alert.
 */
export function ChoreItem({ chore: c, alert, compact = false, disabled = false }: { chore: ChoreRow, alert?: AlertRow, compact?: boolean, disabled?: boolean }) {
  const actions = useChoreActions()
  if (actions.skippedId !== null && (!alert || alert.id === actions.skippedId)) return null
  const labels = alertActions(alertKind(c.id) ?? `chore_${c.id}`)
  const busy = disabled || actions.busy(c.id)
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
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={compact ? 'secondary' : 'primary'} icon={Check} disabled={busy} onClick={() => actions.done(c, alert)}>{labels.resolve}</Button>
          {alert && labels.skip && <Button size="sm" icon={X} className="text-fg-2" title="Close it without logging it as done" disabled={busy} onClick={() => actions.skip(alert)}>{labels.skip}</Button>}
        </div>
        {actions.error && <span className="text-xs text-danger">{actions.error.message}</span>}
      </div>
    </div>
  )
}

/**
 * Water's line into Care: the due chores to act on there, and the setup issues
 * still pointed at; else Care's one line, which counts only the chores not skipped.
 */
export function DueChores() {
  const { items, chores, ready } = useNeedsChores()
  const setup = trpc.care.setup.useQuery(undefined, { refetchInterval: 5 * 60_000 })
  const issues = setup.data?.issues.length ?? 0
  if (!items.length) {
    return (
      <Card className="py-3">
        <CareSummary chores={chores} />
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-2.5">
      <h2 className={EYEBROW}>Needs you</h2>
      <Card className="gap-0 p-0" data-testid="due-chores">
        {items.map(i => <ChoreItem key={i.chore.id} chore={i.chore} alert={i.alert} disabled={!ready} />)}
        {issues > 0 && (
          <Link to="/care" data-testid="due-chores-setup" className="flex items-center gap-2 px-5 py-3 text-[13px] text-fg-2 hover:text-fg">
            <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 text-pod-attention" />
            <span className="min-w-0 flex-1 truncate">{`${issues} setup issue${issues > 1 ? 's' : ''}`}</span>
            <ChevronRight size={14} className="shrink-0 text-fg-3" />
          </Link>
        )}
      </Card>
    </div>
  )
}
