/**
 * The rule builder's form model and its mapping to the rule AST. The form
 * covers the common shape (a list of comparisons joined by AND or OR, an
 * optional time window, an optional "for N minutes", literal action values);
 * a rule outside that shape (made over the API) maps to null and is shown read-only.
 */
import type { Action, CompareOp, Condition, DoserId, Expr, PodStatus, Trigger } from '@/src/autopilot/types'

export type Aggregate = 'now' | 'avg' | 'min' | 'max'
export interface CompareRow { signal: string, agg: Aggregate, windowMin: number, op: CompareOp, value: number }

export type ActionRow
  = | { kind: 'notify', message: string }
    | { kind: 'setLight', level: number, holdMinutes: number | null }
    | { kind: 'runPump', durationS: number }
    | { kind: 'stopPump' }
    | { kind: 'dose', doser: DoserId, durationS: number }
    | { kind: 'setPodStatus', slot: number, status: PodStatus }

export interface Draft {
  name: string
  priority: number
  cooldownMin: number | null
  trigger: Trigger
  join: 'and' | 'or'
  rows: CompareRow[]
  time: { start: string, end: string } | null
  sustainMin: number | null
  actions: ActionRow[]
}

export function emptyDraft(): Draft {
  return {
    name: '',
    priority: 50,
    cooldownMin: 30,
    trigger: { kind: 'tick', everyMin: 5 },
    join: 'and',
    rows: [{ signal: 'sensor.ph', agg: 'now', windowMin: 30, op: '>', value: 6.5 }],
    time: null,
    sustainMin: null,
    actions: [{ kind: 'notify', message: 'pH is high' }],
  }
}

export function defaultAction(kind: ActionRow['kind']): ActionRow {
  switch (kind) {
    case 'notify': return { kind, message: '' }
    case 'setLight': return { kind, level: 50, holdMinutes: null }
    case 'runPump': return { kind, durationS: 60 }
    case 'stopPump': return { kind }
    case 'dose': return { kind, doser: 'dose_1', durationS: 5 }
    case 'setPodStatus': return { kind, slot: 1, status: 'attention' }
  }
}

const lit = (value: number): Expr => ({ kind: 'literal', value })

function rowExpr(r: CompareRow): Expr {
  return r.agg === 'now' ? { kind: 'signal', signal: r.signal } : { kind: 'window', fn: r.agg, signal: r.signal, lastMin: r.windowMin }
}

function actionToAst(a: ActionRow): Action {
  switch (a.kind) {
    case 'setLight': return a.holdMinutes ? { kind: 'setLight', level: lit(a.level), mode: 'one-shot', holdMinutes: a.holdMinutes } : { kind: 'setLight', level: lit(a.level) }
    case 'runPump': return { kind: 'runPump', durationS: lit(a.durationS) }
    case 'dose': return { kind: 'dose', doser: a.doser, durationS: lit(a.durationS) }
    default: return a
  }
}

export function toRule(d: Draft): { name: string, priority: number, cooldownMin: number | null, trigger: Trigger, conditions: Condition, actions: Action[] } {
  const compares: Condition[] = d.rows.map(r => ({ kind: 'compare', op: r.op, left: rowExpr(r), right: lit(r.value) }))
  let cond: Condition = d.join === 'or' && compares.length > 0 ? { kind: 'or', conditions: compares } : { kind: 'and', conditions: compares }
  if (d.sustainMin) cond = { kind: 'sustained', condition: cond, forMin: d.sustainMin }
  if (d.time) cond = { kind: 'and', conditions: [cond, { kind: 'timeBetween', start: d.time.start, end: d.time.end }] }
  return { name: d.name.trim(), priority: d.priority, cooldownMin: d.cooldownMin, trigger: d.trigger, conditions: cond, actions: d.actions.map(actionToAst) }
}

function literal(e: Expr): number | null {
  return e.kind === 'literal' ? e.value : null
}

function rowFrom(c: Condition): CompareRow | null {
  if (c.kind !== 'compare') return null
  const value = literal(c.right)
  if (value === null) return null
  if (c.left.kind === 'signal') return { signal: c.left.signal, agg: 'now', windowMin: 30, op: c.op, value }
  if (c.left.kind === 'window' && (c.left.fn === 'avg' || c.left.fn === 'min' || c.left.fn === 'max')) return { signal: c.left.signal, agg: c.left.fn, windowMin: c.left.lastMin, op: c.op, value }
  return null
}

function actionFrom(a: Action): ActionRow | null {
  switch (a.kind) {
    case 'setLight': {
      const level = literal(a.level)
      if (level === null || a.clamp) return null
      return { kind: 'setLight', level, holdMinutes: a.mode === 'one-shot' ? a.holdMinutes ?? 60 : null }
    }
    case 'runPump': {
      const durationS = literal(a.durationS)
      return durationS === null || a.level ? null : { kind: 'runPump', durationS }
    }
    case 'dose': {
      const durationS = literal(a.durationS)
      return durationS === null ? null : { kind: 'dose', doser: a.doser, durationS }
    }
    default: return a
  }
}

/** The form for a saved rule, or null when the rule uses something the form can't show. */
export function fromRule(r: { name: string, priority: number, cooldownMin: number | null, trigger: Trigger, conditions: Condition, actions: Action[] }): Draft | null {
  let cond = r.conditions
  let time: Draft['time'] = null
  if (cond.kind === 'and' && cond.conditions.length === 2 && cond.conditions[1]?.kind === 'timeBetween' && cond.conditions[0]) {
    time = { start: cond.conditions[1].start, end: cond.conditions[1].end }
    cond = cond.conditions[0]
  }
  let sustainMin: number | null = null
  if (cond.kind === 'sustained') {
    sustainMin = cond.forMin
    cond = cond.condition
  }
  if (cond.kind !== 'and' && cond.kind !== 'or') return null
  const rows = cond.conditions.map(rowFrom)
  const actions = r.actions.map(actionFrom)
  if (rows.some(x => x === null) || actions.some(x => x === null)) return null
  return { name: r.name, priority: r.priority, cooldownMin: r.cooldownMin, trigger: r.trigger, join: cond.kind, rows: rows as CompareRow[], time, sustainMin, actions: actions as ActionRow[] }
}

/** What's wrong with a draft, if anything, before it goes to the server. */
export function problems(d: Draft): string[] {
  const out: string[] = []
  if (!d.name.trim()) out.push('Give the rule a name.')
  if (d.actions.length === 0) out.push('Add at least one action.')
  if (d.actions.some(a => a.kind === 'notify' && !a.message.trim())) out.push('A notification needs a message.')
  if (d.rows.some(r => !Number.isFinite(r.value))) out.push('Every comparison needs a number.')
  return out
}
