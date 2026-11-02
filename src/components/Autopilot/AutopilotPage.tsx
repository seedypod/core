import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { describeRule } from '@/src/autopilot/describe'
import type { AutomationRule } from '@/src/autopilot/types'
import { Button, GhostIcon, InlineError, SectionLabel } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { Toggle } from '@/src/components/ds/forms'
import { trpc } from '@/src/utils/trpc'
import { backtestLine, lastDay, lightLine, modePatch, ruleMode, statusLine, type BacktestSummary, type LightOwner } from './autopilotLogic'
import { BacktestPanel } from './BacktestPanel'
import { fromRule, type Draft } from './builderModel'
import { ActivityCard, LastDayCard, ModeControl, Sparkline } from './parts'
import { RuleEditor } from './RuleEditor'

const lit = (value: number) => ({ kind: 'literal' as const, value })
const sig = (signal: string) => ({ kind: 'signal' as const, signal })

/** Starters for an empty list; each opens the editor prefilled, in dry run. */
const TEMPLATES: Array<{ id: string, title: string, description: string, rule: Omit<AutomationRule, 'id' | 'enabled' | 'dryRun'> }> = [
  { id: 'tank', title: 'Tank getting low', description: 'Tell me when the tank drops below 30 %.', rule: { name: 'Tank getting low', priority: 50, cooldownMin: 240, trigger: { kind: 'tick', everyMin: 15 }, conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '<', left: sig('sensor.water_level_pct'), right: lit(30) }] }, actions: [{ kind: 'notify', message: 'top up the tank' }] } },
  { id: 'hot', title: 'Dim when hot', description: 'Turn the light down to 60 % when the air is over 29 °C.', rule: { name: 'Dim when hot', priority: 60, cooldownMin: 30, trigger: { kind: 'tick', everyMin: 5 }, conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('sensor.air_temp'), right: lit(29) }] }, actions: [{ kind: 'setLight', level: lit(60) }] } },
  { id: 'ph', title: 'pH drifting up', description: 'Dose pH-down for 5 s when pH goes over 6.5.', rule: { name: 'pH drifting up', priority: 50, cooldownMin: 360, trigger: { kind: 'tick', everyMin: 10 }, conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('sensor.ph'), right: lit(6.5) }] }, actions: [{ kind: 'dose', doser: 'dose_1', durationS: lit(5) }] } },
]

/** Enough of the run log to cover a day of checks for a handful of rules. */
const RUNS = 1000

/**
 * Autopilot (ADR-0020), laid out as sleepypod's: the status line and kill
 * switch, the last 24 hours as lanes, the rules with their mode and a standing
 * 7-day backtest, and the activity log. A rule opens in the editor.
 */
export function AutopilotPage() {
  const utils = trpc.useUtils()
  const rules = trpc.automations.list.useQuery()
  const status = trpc.automations.status.useQuery(undefined, { refetchInterval: 15_000 })
  const runs = trpc.automations.runs.useQuery({ limit: RUNS })
  const backtests = trpc.automations.backtests.useQuery(undefined, { staleTime: 5 * 60_000 })
  const signals = trpc.automations.catalog.useQuery()
  const refresh = { onSuccess: () => void utils.automations.invalidate() }
  const update = trpc.automations.update.useMutation(refresh)
  const remove = trpc.automations.remove.useMutation(refresh)
  const setGlobal = trpc.automations.setGlobal.useMutation(refresh)
  const [editing, setEditing] = useState<{ id: number | null, draft: Draft | null } | null>(null)
  const [details, setDetails] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [now] = useState(() => Date.now())
  const info = new Map((signals.data ?? []).map(s => [s.key, s]))
  const labels = (k: string) => info.get(k)
  const all = rules.data ?? []
  const names = new Map(all.map(r => [r.id, r.name]))
  const summaries = new Map((backtests.data ?? []).map(s => [s.id, s as BacktestSummary]))
  const st = status.data
  const killed = st?.enabled === false
  const day = lastDay(runs.data ?? [], now, RUNS)
  const atLeast = day.partial ? '≥' : ''
  const plural = (n: number, w: string) => `${atLeast}${n} ${w}${n === 1 ? '' : 's'}`

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 min-[900px]:pt-3">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Autopilot</h1>
          {rules.data && <span className="text-[13px] text-fg-2" data-testid="automations-status">{statusLine(all)}</span>}
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-fg-2">
          {killed ? 'Off' : 'On'}
          <Toggle size="md" label="Autopilot enabled" on={!killed} onChange={on => setGlobal.mutate({ enabled: on })} />
        </label>
        <Button variant="primary" icon={Plus} onClick={() => setEditing({ id: null, draft: null })}>New rule</Button>
      </div>

      {killed && (
        <div role="status" className="rounded-ctl border border-line-2 bg-active px-4 py-2.5 text-[13px] text-fg-2">
          Autopilot is off. No rule runs, and the light is back with you and the schedule.
        </div>
      )}

      <LastDayCard
        light={st?.light ? lightLine(st.light as LightOwner, names) : null}
        rules={all.map(r => ({ id: r.id, name: r.name, mode: ruleMode(r) }))}
        runs={runs.data ?? []}
        now={now}
        counts={`${plural(day.checks, 'check')} · ${plural(day.actions, 'action')}`}
      />

      <SectionLabel>Rules</SectionLabel>
      {all.length === 0 && rules.data && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[13px] text-fg-2">No rules yet. A rule watches readings (pH, temperature, tank level, how a pod is growing) and acts: notify you, set the light, run the pump or a doser, or flag a pod. Start from one of these:</p>
          <div className="grid gap-2.5 min-[720px]:grid-cols-3">
            {TEMPLATES.map(t => (
              <button key={t.id} type="button" onClick={() => setEditing({ id: null, draft: fromRule(t.rule) })} className="flex cursor-pointer flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:bg-active">
                <span className="text-sm font-medium text-fg">{t.title}</span>
                <span className="text-[13px] leading-snug text-fg-2">{t.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3">
        {all.map((r) => {
          const draft = fromRule(r)
          const live = st?.rules.find(x => x.id === r.id)
          const bt = summaries.get(r.id)
          const open = () => (draft ? setEditing({ id: r.id, draft }) : setDetails(details === r.id ? null : r.id))
          return (
            <div key={r.id} className="flex flex-col gap-3.5 rounded-[14px] border border-line bg-surface px-5 py-[18px]" data-testid={`rule-${r.id}`}>
              <div
                role="button"
                tabIndex={0}
                aria-label={`Open ${r.name}`}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    open()
                  }
                }}
                className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 rounded-ctl focus:outline-none focus-visible:bg-active max-[720px]:grid-cols-1"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="text-[15px] font-medium text-fg">{r.name}</span>
                    {r.lastRun?.outcome === 'error' && <span className="font-mono text-[12px] text-[var(--status-danger)]">last run failed</span>}
                    {live?.cooldownUntil && <span className="font-mono text-[11px] text-fg-3">{`cooling down until ${new Date(live.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span>}
                    {live && live.actionsLastHour > 0 && <span className="font-mono text-[11px] text-fg-3">{`${live.actionsLastHour} action${live.actionsLastHour === 1 ? '' : 's'} this hour`}</span>}
                  </div>
                  <span className="text-[13px] leading-[1.6] text-fg-2 text-pretty">{describeRule(r, labels)}</span>
                </div>
                <div className="flex items-center gap-3 max-[720px]:justify-between">
                  <ModeControl name={r.name} value={ruleMode(r)} onChange={m => update.mutate({ id: r.id, ...modePatch(m) })} />
                  <GhostIcon
                    icon={Trash2}
                    label={`Delete ${r.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleting(r.id)
                    }}
                  />
                  <ChevronRight size={16} className="text-fg-3 transition-colors group-hover:text-fg" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 rounded-[10px] bg-field px-3.5 py-2.5">
                {bt && <Sparkline s={bt} />}
                <span className="min-w-[200px] flex-1 font-mono text-xs text-fg-2" data-testid={`backtest-${r.id}`}>{backtestLine(bt)}</span>
                <button
                  type="button"
                  aria-expanded={details === r.id}
                  onClick={() => setDetails(details === r.id ? null : r.id)}
                  className="cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-3 hover:text-fg"
                >
                  {details === r.id ? 'Hide replay' : 'Replay window'}
                </button>
              </div>
              {details === r.id && <BacktestPanel id={r.id} />}
            </div>
          )
        })}
      </div>
      {(update.error ?? setGlobal.error) && <InlineError>{(update.error ?? setGlobal.error)?.message}</InlineError>}

      <ActivityCard runs={runs.data ?? []} names={names} idle={`No rule has acted in 24 h. ${plural(day.idle, 'check')} found nothing to do.`} />

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
