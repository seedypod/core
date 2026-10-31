import { Pencil, Plus, Trash2, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { describeRule } from '@/src/autopilot/describe'
import { Badge, Button, Card, CardHeader, InlineError, SectionLabel, StatusDot } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { Toggle } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { trpc } from '@/src/utils/trpc'
import { BacktestPanel } from './BacktestPanel'
import { fromRule, type Draft } from './builderModel'
import { RuleEditor } from './RuleEditor'

const OUTCOME_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = { fired: 'ok', clamped: 'ok', dry_run: 'muted', skipped: 'muted', refused: 'warn', error: 'danger' }
const OUTCOME_LABEL: Record<string, string> = { fired: 'fired', clamped: 'fired (clamped)', dry_run: 'would fire', skipped: 'skipped', refused: 'refused', error: 'error' }
const ago = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Reasons and refusals from a run's detail, in a line a person can read. */
function why(detail: unknown): string {
  const d = (detail ?? {}) as { reason?: string, actions?: Array<{ kind: string, value?: number, refused?: string, error?: string, skipped?: string }> }
  if (d.reason) return d.reason.replace(/-/g, ' ')
  return (d.actions ?? []).map(a => a.refused ?? a.error ?? (a.skipped ? `${a.kind}: ${a.skipped}` : `${a.kind}${a.value !== undefined ? ` ${a.value}` : ''}`)).join(', ')
}

/**
 * Autopilot (ADR-0020): rules that react to readings. Kill switch, rules with
 * their state and last outcome, the builder, backtests, and the audit log.
 */
export function AutopilotPage() {
  const utils = trpc.useUtils()
  const rules = trpc.automations.list.useQuery()
  const status = trpc.automations.status.useQuery(undefined, { refetchInterval: 15_000 })
  const runs = trpc.automations.runs.useQuery({ limit: 30 })
  const signals = trpc.automations.catalog.useQuery()
  const refresh = { onSuccess: () => void utils.automations.invalidate() }
  const update = trpc.automations.update.useMutation(refresh)
  const remove = trpc.automations.remove.useMutation(refresh)
  const setGlobal = trpc.automations.setGlobal.useMutation(refresh)
  const [editing, setEditing] = useState<{ id: number | null, draft: Draft | null } | null>(null)
  const [testing, setTesting] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const info = new Map((signals.data ?? []).map(s => [s.key, s]))
  const labels = (k: string) => info.get(k)
  const names = new Map((rules.data ?? []).map(r => [r.id, r.name]))
  const st = status.data
  const light = st?.light

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Autopilot" right={<Button variant="primary" icon={Plus} onClick={() => setEditing({ id: null, draft: null })}>New rule</Button>} />

      <Card>
        <CardHeader
          title="Autopilot"
          subtitle={st?.enabled === false ? 'Off: no rule runs and the light is back with you and the schedule.' : 'Rules run every minute. The hardware guards still bound every pump run and dose.'}
          icon={Wand2}
          right={<Toggle label="Autopilot on" on={st?.enabled ?? true} onChange={on => setGlobal.mutate({ enabled: on })} />}
        />
        {light && (
          <p className="mt-2 text-xs text-fg-3">
            {`Light: ${light.source === 'manual' ? `held by hand until ${new Date(light.manualUntil ?? '').toLocaleTimeString()}` : light.source === 'autopilot' ? `set by ${names.get(Number(light.leaseId?.split(':')[1])) ?? 'a rule'}` : light.source === 'schedule' ? 'following the schedule' : 'idle'}${light.level !== null ? ` · ${light.level} %` : ''}`}
          </p>
        )}
      </Card>

      {rules.data?.length === 0 && (
        <Card dashed><p className="text-[13px] text-fg-2">No rules yet. A rule watches readings (pH, temperature, tank level, how a pod is growing) and acts: notify you, set the light, run the pump or a doser, or flag a pod.</p></Card>
      )}
      {rules.data?.map((r) => {
        const draft = fromRule(r)
        const live = st?.rules.find(x => x.id === r.id)
        return (
          <Card key={r.id} tone={r.lastRun?.outcome === 'error' ? 'warn' : undefined}>
            <CardHeader
              title={r.name}
              subtitle={describeRule(r, labels)}
              right={(
                <div className="flex items-center gap-2">
                  {!r.enabled && <Badge variant="paused">Off</Badge>}
                  {r.enabled && <Badge variant={r.dryRun ? 'dev' : 'active'}>{r.dryRun ? 'Dry run' : 'Armed'}</Badge>}
                </div>
              )}
            />
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
              {r.lastRun ? <StatusDot tone={OUTCOME_TONE[r.lastRun.outcome] ?? 'muted'} label={`${OUTCOME_LABEL[r.lastRun.outcome]} · ${ago(r.lastRun.firedAt)}`} /> : <span>Not run yet</span>}
              {live?.cooldownUntil && <span>{`cooling down until ${new Date(live.cooldownUntil).toLocaleTimeString()}`}</span>}
              {live && live.actionsLastHour > 0 && <span>{`${live.actionsLastHour} action${live.actionsLastHour === 1 ? '' : 's'} this hour`}</span>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant={r.dryRun ? 'primary' : 'secondary'} disabled={!r.enabled} onClick={() => update.mutate({ id: r.id, dryRun: !r.dryRun })}>{r.dryRun ? 'Arm' : 'Back to dry run'}</Button>
              <Button size="sm" onClick={() => update.mutate({ id: r.id, enabled: !r.enabled })}>{r.enabled ? 'Turn off' : 'Turn on'}</Button>
              <Button size="sm" icon={Pencil} disabled={!draft} title={draft ? undefined : 'Made through the API in a shape the form can\'t show'} onClick={() => setEditing({ id: r.id, draft })}>Edit</Button>
              <Button size="sm" onClick={() => setTesting(testing === r.id ? null : r.id)}>{testing === r.id ? 'Hide backtest' : 'Backtest'}</Button>
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDeleting(r.id)}>Delete</Button>
            </div>
            {testing === r.id && <div className="mt-3"><BacktestPanel id={r.id} /></div>}
          </Card>
        )
      })}
      {(update.error ?? setGlobal.error) && <InlineError>{(update.error ?? setGlobal.error)?.message}</InlineError>}

      <SectionLabel>Run log</SectionLabel>
      <Card>
        {runs.data?.length === 0 && <p className="text-[13px] text-fg-2">Nothing yet. Every time a rule&apos;s trigger comes round, its outcome lands here.</p>}
        <ul className="flex flex-col" aria-label="Run log">
          {runs.data?.map(run => (
            <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-1.5 text-[13px] first:border-t-0">
              <span className="w-28 shrink-0 font-mono text-xs text-fg-3">{ago(run.firedAt)}</span>
              <StatusDot tone={OUTCOME_TONE[run.outcome] ?? 'muted'} label={OUTCOME_LABEL[run.outcome] ?? run.outcome} />
              <span className="text-fg">{names.get(run.automationId) ?? `rule ${run.automationId}`}</span>
              <span className="text-fg-2">{why(run.detail)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {editing && <RuleEditor id={editing.id} initial={editing.draft} onClose={() => setEditing(null)} />}
      {deleting !== null && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={`Delete ${names.get(deleting) ?? 'rule'}?`}
          icon={Trash2}
          footer={(
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => remove.mutate({ id: deleting }, { onSuccess: () => setDeleting(null) })}>Delete</Button>
            </div>
          )}
        >
          <p className="text-sm text-fg-2">Its run log goes with it. A light it was holding goes back to the schedule.</p>
        </Modal>
      )}
    </div>
  )
}
