/** Plain-English rendering of a rule, for the builder's preview and the rule list (ADR-0020). */
import type { Action, AutomationRule, Condition, Expr, Trigger } from './types'

export type Labels = (key: string) => { label: string, unit: string } | undefined

const OPS: Record<string, string> = { '>': 'is above', '>=': 'is at least', '<': 'is below', '<=': 'is at most', '==': 'is', '!=': 'is not' }
const FNS: Record<string, string> = { avg: 'average', min: 'lowest', max: 'highest', sum: 'total', count: 'number of readings of' }

/** "Air temperature" → "air temperature", but "pH" and "EC" stay as they are. */
function lower(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0]?.toLowerCase() + label.slice(1) : label
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)
}

export function describeExpr(e: Expr, labels: Labels): string {
  switch (e.kind) {
    case 'literal': return num(e.value)
    case 'signal': return lower(labels(e.signal)?.label ?? e.signal)
    case 'window': return `the ${FNS[e.fn]} ${lower(labels(e.signal)?.label ?? e.signal)} over ${e.lastMin} min`
    case 'binary': return `${describeExpr(e.left, labels)} ${e.op === '*' ? '×' : e.op === '/' ? '÷' : e.op} ${describeExpr(e.right, labels)}`
    case 'clamp': return `${describeExpr(e.value, labels)} (kept within ${describeExpr(e.min, labels)}–${describeExpr(e.max, labels)})`
  }
}

function unitOf(e: Expr, labels: Labels): string {
  const u = e.kind === 'signal' || e.kind === 'window' ? labels(e.signal)?.unit : undefined
  return u && !['1/0', '0–1', 'per capture', 'pH'].includes(u) ? (u === '%' || u.startsWith('°') ? u : ` ${u}`) : ''
}

export function describeCondition(c: Condition, labels: Labels): string {
  switch (c.kind) {
    case 'and': return c.conditions.length === 0 ? 'always' : c.conditions.map(x => describeCondition(x, labels)).join(' and ')
    case 'or': return c.conditions.map(x => describeCondition(x, labels)).join(' or ')
    case 'not': return `not (${describeCondition(c.condition, labels)})`
    case 'compare': return `${describeExpr(c.left, labels)} ${OPS[c.op]} ${describeExpr(c.right, labels)}${unitOf(c.left, labels)}`
    case 'between': return `${describeExpr(c.subject, labels)} is between ${describeExpr(c.min, labels)} and ${describeExpr(c.max, labels)}${unitOf(c.subject, labels)}`
    case 'timeBetween': return `it's between ${c.start} and ${c.end}`
    case 'onDays': return `it's ${c.days.map(d => d[0]?.toUpperCase() + d.slice(1, 3)).join(', ')}`
    case 'sustained': return `${describeCondition(c.condition, labels)} for ${c.forMin} min`
  }
}

export function describeTrigger(t: Trigger, labels: Labels): string {
  switch (t.kind) {
    case 'tick': return t.everyMin === 1 ? 'Every minute' : `Every ${t.everyMin} minutes`
    case 'signalChange': return `When ${lower(labels(t.signal)?.label ?? t.signal)} changes`
    case 'timeOfDay': return `At ${t.at}${t.days ? ` on ${t.days.map(d => d[0]?.toUpperCase() + d.slice(1, 3)).join(', ')}` : ''}`
  }
}

export function describeAction(a: Action, labels: Labels): string {
  switch (a.kind) {
    case 'notify': return `notify “${a.message}”`
    case 'setLight': {
      const band = a.clamp ? ` (kept within ${a.clamp.min}–${a.clamp.max}%)` : ''
      const hold = a.mode === 'one-shot' || (a.mode === undefined && a.holdMinutes) ? `, holding ${a.holdMinutes ?? 60} min` : ''
      return `set the light to ${describeExpr(a.level, labels)}%${band}${hold}`
    }
    case 'runPump': return `run the pump for ${describeExpr(a.durationS, labels)} s${a.level ? ` at ${a.level}%` : ''}`
    case 'stopPump': return 'stop the pump'
    case 'dose': return `run doser ${a.doser.slice(-1)} for ${describeExpr(a.durationS, labels)} s`
    case 'setPodStatus': return `mark pod ${a.slot} as ${a.status}`
  }
}

/** “Every 5 minutes, if pH is above 6.5 for 30 min, run doser 1 for 5 s.” */
export function describeRule(r: Pick<AutomationRule, 'trigger' | 'conditions' | 'actions' | 'cooldownMin'>, labels: Labels): string {
  const cond = describeCondition(r.conditions, labels)
  const when = describeTrigger(r.trigger, labels)
  const then = r.actions.map(a => describeAction(a, labels)).join(', then ')
  const cooldown = r.cooldownMin ? ` At most once every ${r.cooldownMin} min.` : ''
  return `${when}${cond === 'always' ? '' : `, if ${cond}`}, ${then}.${cooldown}`
}
