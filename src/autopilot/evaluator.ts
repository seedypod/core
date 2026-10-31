/**
 * Condition (IF) evaluation with three-valued logic (ported from sleepypod).
 * `undefined` is "unknown": an operand had no value. The engine treats unknown
 * as a skip, never a fire. AND short-circuits on false, OR on true.
 */
import { evaluateExpr, type EvalContext } from './expressions'
import type { CompareOp, Condition } from './types'

function compare(op: CompareOp, l: number, r: number): boolean {
  switch (op) {
    case '>': return l > r
    case '>=': return l >= r
    case '<': return l < r
    case '<=': return l <= r
    case '==': return l === r
    case '!=': return l !== r
  }
}

export function toMinutes(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Inclusive start, exclusive end; wraps past midnight (23:00–06:00). */
export function inTimeWindow(nowMin: number, start: string, end: string): boolean {
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === e) return false
  if (s < e) return nowMin >= s && nowMin < e
  return nowMin >= s || nowMin < e
}

/** `path` names the node within its rule, so `sustained` state survives between ticks. */
export function evaluateCondition(cond: Condition, ctx: EvalContext, path = 'c'): boolean | undefined {
  switch (cond.kind) {
    case 'and': {
      let unknown = false
      for (const [i, c] of cond.conditions.entries()) {
        const r = evaluateCondition(c, ctx, `${path}.${i}`)
        if (r === false) return false
        if (r === undefined) unknown = true
      }
      return unknown ? undefined : true
    }
    case 'or': {
      let unknown = false
      for (const [i, c] of cond.conditions.entries()) {
        const r = evaluateCondition(c, ctx, `${path}.${i}`)
        if (r === true) return true
        if (r === undefined) unknown = true
      }
      return unknown ? undefined : false
    }
    case 'not': {
      const r = evaluateCondition(cond.condition, ctx, `${path}.n`)
      return r === undefined ? undefined : !r
    }
    case 'compare': {
      const l = evaluateExpr(cond.left, ctx)
      const r = evaluateExpr(cond.right, ctx)
      if (l === undefined || r === undefined) return undefined
      return compare(cond.op, l, r)
    }
    case 'between': {
      const v = evaluateExpr(cond.subject, ctx)
      const lo = evaluateExpr(cond.min, ctx)
      const hi = evaluateExpr(cond.max, ctx)
      if (v === undefined || lo === undefined || hi === undefined) return undefined
      return v >= lo && v <= hi
    }
    case 'timeBetween':
      return inTimeWindow(ctx.nowMinutes, cond.start, cond.end)
    case 'onDays':
      return cond.days.includes(ctx.dayOfWeek)
    case 'sustained':
      return ctx.sustain.held(path, evaluateCondition(cond.condition, ctx, `${path}.s`), cond.forMin, ctx.nowMs)
  }
}
