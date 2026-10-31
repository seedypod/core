/** Walkers over the rule AST: which signals a rule reads, and its longest window. */
import type { Action, AutomationRule, Condition, Expr } from './types'

export function exprs(cond: Condition): Expr[] {
  switch (cond.kind) {
    case 'and':
    case 'or': return cond.conditions.flatMap(exprs)
    case 'not': return exprs(cond.condition)
    case 'sustained': return exprs(cond.condition)
    case 'compare': return [cond.left, cond.right]
    case 'between': return [cond.subject, cond.min, cond.max]
    default: return []
  }
}

export function actionExprs(a: Action): Expr[] {
  switch (a.kind) {
    case 'setLight': return [a.level]
    case 'runPump': return [a.durationS]
    case 'dose': return [a.durationS]
    default: return []
  }
}

function walk(e: Expr, visit: (e: Expr) => void): void {
  visit(e)
  if (e.kind === 'binary') {
    walk(e.left, visit)
    walk(e.right, visit)
  }
  else if (e.kind === 'clamp') {
    walk(e.value, visit)
    walk(e.min, visit)
    walk(e.max, visit)
  }
}

function allExprs(rule: Pick<AutomationRule, 'conditions' | 'actions'>): Expr[] {
  return [...exprs(rule.conditions), ...rule.actions.flatMap(actionExprs)]
}

/** Every signal key a rule reads, including its trigger. */
export function signalsOf(rule: Pick<AutomationRule, 'trigger' | 'conditions' | 'actions'>): string[] {
  const out = new Set<string>()
  if (rule.trigger.kind === 'signalChange') out.add(rule.trigger.signal)
  for (const e of allExprs(rule)) walk(e, (n) => {
    if (n.kind === 'signal' || n.kind === 'window') out.add(n.signal)
  })
  return [...out]
}

/** Signals some rule aggregates over a window: these get sampled every tick. */
export function windowedSignals(rules: Array<Pick<AutomationRule, 'conditions' | 'actions'>>): Set<string> {
  const out = new Set<string>()
  for (const r of rules) for (const e of allExprs(r)) walk(e, (n) => {
    if (n.kind === 'window') out.add(n.signal)
  })
  return out
}

export function maxWindowMin(rules: Array<Pick<AutomationRule, 'conditions' | 'actions'>>): number {
  let max = 10
  for (const r of rules) for (const e of allExprs(r)) walk(e, (n) => {
    if (n.kind === 'window') max = Math.max(max, n.lastMin)
  })
  return max
}
