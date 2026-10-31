import { Plus, Trash2, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { describeRule } from '@/src/autopilot/describe'
import type { CompareOp, DayOfWeek, DoserId, PodStatus } from '@/src/autopilot/types'
import { Button, InlineError, SectionLabel } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, SelectValue, TextField, Toggle } from '@/src/components/ds/forms'
import { SettingRow } from '@/src/components/ds/layout'
import { trpc } from '@/src/utils/trpc'
import { BacktestPanel } from './BacktestPanel'
import { defaultAction, emptyDraft, problems, toRule, type ActionRow, type Aggregate, type CompareRow, type Draft } from './builderModel'

const OPS: ReadonlyArray<{ value: CompareOp, label: string }> = [{ value: '>', label: '>' }, { value: '>=', label: '≥' }, { value: '<', label: '<' }, { value: '<=', label: '≤' }, { value: '==', label: '=' }, { value: '!=', label: '≠' }]
const AGGS: ReadonlyArray<{ value: Aggregate, label: string }> = [{ value: 'now', label: 'now' }, { value: 'avg', label: 'average' }, { value: 'min', label: 'lowest' }, { value: 'max', label: 'highest' }]
const ACTIONS: ReadonlyArray<{ value: ActionRow['kind'], label: string }> = [
  { value: 'notify', label: 'Notify' }, { value: 'setLight', label: 'Set light' }, { value: 'runPump', label: 'Run pump' },
  { value: 'stopPump', label: 'Stop pump' }, { value: 'dose', label: 'Run doser' }, { value: 'setPodStatus', label: 'Mark pod' },
]
const DOSERS: ReadonlyArray<{ value: DoserId, label: string }> = [{ value: 'dose_1', label: 'Doser 1' }, { value: 'dose_2', label: 'Doser 2' }, { value: 'dose_3', label: 'Doser 3' }]
const STATUSES: ReadonlyArray<{ value: PodStatus, label: string }> = (['attention', 'growing', 'harvest', 'seeded', 'empty'] as const).map(s => ({ value: s, label: s }))
const WEEKDAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s))

/** WHEN / IF / THEN form with a live sentence preview and a backtest of the draft. */
export function RuleEditor({ id, initial, onClose }: { id: number | null, initial: Draft | null, onClose: () => void }) {
  const [d, setD] = useState<Draft>(() => initial ?? emptyDraft())
  const [testing, setTesting] = useState(false)
  const utils = trpc.useUtils()
  const signals = trpc.automations.catalog.useQuery()
  const done = { onSuccess: () => {
    void utils.automations.invalidate()
    onClose()
  } }
  const create = trpc.automations.create.useMutation(done)
  const update = trpc.automations.update.useMutation(done)
  const info = new Map((signals.data ?? []).map(s => [s.key, s]))
  const labels = (k: string) => info.get(k)
  const signalOptions = (signals.data ?? []).map(s => ({ value: s.key, label: `${s.label}${s.unit && s.unit !== '1/0' && s.unit !== s.label ? ` (${s.unit})` : ''}` }))
  const issues = problems(d)
  const rule = toRule(d)
  const save = () => (id === null ? create.mutate(rule) : update.mutate({ id, ...rule }))
  const setRow = (i: number, patch: Partial<CompareRow>) => setD({ ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const setAction = (i: number, a: ActionRow) => setD({ ...d, actions: d.actions.map((x, j) => (j === i ? a : x)) })
  const error = create.error ?? update.error

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title={id === null ? 'New rule' : 'Edit rule'}
      icon={Wand2}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setTesting(t => !t)}>{testing ? 'Hide backtest' : 'Backtest'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={issues.length > 0 || create.isPending || update.isPending} onClick={save}>Save</Button>
        </div>
      )}
    >
      <TextField label="Name" mono={false} value={d.name} onChange={v => setD({ ...d, name: v })} placeholder="Dim when hot" />
      <p className="rounded-ctl bg-active px-3 py-2 text-[13px] text-fg" aria-label="Rule preview">{describeRule(rule, labels)}</p>

      <SectionLabel>When</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          ariaLabel="Trigger"
          size="sm"
          value={d.trigger.kind}
          options={[{ value: 'tick', label: 'Every' }, { value: 'signalChange', label: 'On change' }, { value: 'timeOfDay', label: 'At a time' }]}
          onChange={k => setD({ ...d, trigger: k === 'tick' ? { kind: 'tick', everyMin: 5 } : k === 'signalChange' ? { kind: 'signalChange', signal: d.rows[0]?.signal ?? 'sensor.ph' } : { kind: 'timeOfDay', at: '08:00' } })}
        />
        {d.trigger.kind === 'tick' && <TextField label="Minutes" value={String(d.trigger.everyMin)} inputMode="numeric" onChange={v => setD({ ...d, trigger: { kind: 'tick', everyMin: Math.max(1, Math.round(num(v)) || 1) } })} />}
        {d.trigger.kind === 'signalChange' && <SelectValue label="Signal" value={d.trigger.signal} options={signalOptions} onChange={s => setD({ ...d, trigger: { kind: 'signalChange', signal: s } })} />}
        {d.trigger.kind === 'timeOfDay' && (
          <>
            <TextField label="Time" value={d.trigger.at} onChange={v => d.trigger.kind === 'timeOfDay' && setD({ ...d, trigger: { ...d.trigger, at: v } })} placeholder="08:00" />
            <div className="flex gap-1" role="group" aria-label="Days">
              {WEEKDAYS.map((day) => {
                const days = d.trigger.kind === 'timeOfDay' ? d.trigger.days : undefined
                const on = !days || days.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    className={`cursor-pointer rounded-ctl border px-2 py-1 text-xs ${on ? 'border-fg text-fg' : 'border-line-2 text-fg-3'}`}
                    onClick={() => {
                      const cur = days ?? WEEKDAYS
                      const next = on ? cur.filter(x => x !== day) : [...cur, day]
                      if (d.trigger.kind === 'timeOfDay' && next.length > 0) setD({ ...d, trigger: { ...d.trigger, days: next.length === 7 ? undefined : WEEKDAYS.filter(x => next.includes(x)) } })
                    }}
                  >
                    {day.slice(0, 2)}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      <SectionLabel right={d.rows.length > 1 && <SegmentedControl ariaLabel="Join" size="sm" value={d.join} options={[{ value: 'and', label: 'all' }, { value: 'or', label: 'any' }]} onChange={j => setD({ ...d, join: j })} />}>If</SectionLabel>
      {d.rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2" data-testid="condition-row">
          <SelectValue label="Signal" value={r.signal} options={signalOptions} onChange={s => setRow(i, { signal: s })} />
          <SelectValue label="Aggregate" value={r.agg} options={AGGS} onChange={a => setRow(i, { agg: a })} />
          {r.agg !== 'now' && <TextField label="Over minutes" value={String(r.windowMin)} inputMode="numeric" onChange={v => setRow(i, { windowMin: Math.max(1, Math.round(num(v)) || 1) })} />}
          <SelectValue label="Operator" value={r.op} options={OPS} onChange={op => setRow(i, { op })} />
          <TextField label="Value" value={Number.isNaN(r.value) ? '' : String(r.value)} inputMode="decimal" onChange={v => setRow(i, { value: num(v) })} />
          <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove condition" onClick={() => setD({ ...d, rows: d.rows.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" icon={Plus} onClick={() => setD({ ...d, rows: [...d.rows, { signal: 'sensor.air_temp', agg: 'now', windowMin: 30, op: '>', value: 30 }] })}>Condition</Button>
        <SettingRow label="Held for" sub="minutes, to ride out a noisy reading" divider={false}>
          <TextField label="Held for minutes" value={d.sustainMin === null ? '' : String(d.sustainMin)} inputMode="numeric" placeholder="—" onChange={v => setD({ ...d, sustainMin: v.trim() ? Math.max(1, Math.round(num(v)) || 1) : null })} />
        </SettingRow>
        <SettingRow label="Only between" divider={false}>
          <div className="flex items-center gap-2">
            <Toggle label="Only between" on={d.time !== null} onChange={on => setD({ ...d, time: on ? { start: '08:00', end: '20:00' } : null })} />
            {d.time && (
              <>
                <TextField label="From" value={d.time.start} onChange={v => d.time && setD({ ...d, time: { ...d.time, start: v } })} />
                <TextField label="To" value={d.time.end} onChange={v => d.time && setD({ ...d, time: { ...d.time, end: v } })} />
              </>
            )}
          </div>
        </SettingRow>
      </div>

      <SectionLabel>Then</SectionLabel>
      {d.actions.map((a, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2" data-testid="action-row">
          <SelectValue label="Action" value={a.kind} options={ACTIONS} onChange={k => setAction(i, defaultAction(k))} />
          {a.kind === 'notify' && <TextField label="Message" mono={false} value={a.message} onChange={v => setAction(i, { ...a, message: v })} />}
          {a.kind === 'setLight' && (
            <>
              <TextField label="Level %" value={String(a.level)} inputMode="numeric" onChange={v => setAction(i, { ...a, level: Math.min(100, Math.max(0, Math.round(num(v)) || 0)) })} />
              <TextField label="Hold minutes" value={a.holdMinutes === null ? '' : String(a.holdMinutes)} placeholder="while true" inputMode="numeric" onChange={v => setAction(i, { ...a, holdMinutes: v.trim() ? Math.max(1, Math.round(num(v)) || 1) : null })} />
            </>
          )}
          {a.kind === 'runPump' && <TextField label="Seconds" value={String(a.durationS)} inputMode="numeric" onChange={v => setAction(i, { ...a, durationS: Math.max(1, Math.round(num(v)) || 1) })} />}
          {a.kind === 'dose' && (
            <>
              <SelectValue label="Doser" value={a.doser} options={DOSERS} onChange={doser => setAction(i, { ...a, doser })} />
              <TextField label="Seconds" value={String(a.durationS)} inputMode="numeric" onChange={v => setAction(i, { ...a, durationS: Math.max(1, Math.round(num(v)) || 1) })} />
            </>
          )}
          {a.kind === 'setPodStatus' && (
            <>
              <TextField label="Pod" value={String(a.slot)} inputMode="numeric" onChange={v => setAction(i, { ...a, slot: Math.min(30, Math.max(1, Math.round(num(v)) || 1)) })} />
              <SelectValue label="Status" value={a.status} options={STATUSES} onChange={status => setAction(i, { ...a, status })} />
            </>
          )}
          <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove action" onClick={() => setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <div><Button size="sm" icon={Plus} onClick={() => setD({ ...d, actions: [...d.actions, defaultAction('notify')] })}>Action</Button></div>

      <div className="flex flex-wrap gap-3">
        <TextField label="Cooldown minutes" value={d.cooldownMin === null ? '' : String(d.cooldownMin)} placeholder="none" inputMode="numeric" onChange={v => setD({ ...d, cooldownMin: v.trim() ? Math.max(0, Math.round(num(v)) || 0) : null })} />
        <TextField label="Priority" value={String(d.priority)} inputMode="numeric" hint="Higher wins when two rules want the light" onChange={v => setD({ ...d, priority: Math.min(100, Math.max(0, Math.round(num(v)) || 0)) })} />
      </div>
      {id === null && <p className="text-xs text-fg-3">New rules start in dry-run: they log what they would do without touching anything until you arm them.</p>}
      {issues.map(p => <InlineError key={p}>{p}</InlineError>)}
      {error && <InlineError>{error.message}</InlineError>}
      {testing && (problems({ ...d, name: d.name || 'draft' }).length === 0
        ? <BacktestPanel rule={{ ...rule, name: rule.name || 'draft' }} />
        : <p className="text-xs text-fg-3">Fix the rule above to backtest it.</p>)}
    </Modal>
  )
}
