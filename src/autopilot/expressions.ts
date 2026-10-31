/**
 * Expression evaluation (ported from sleepypod). Every expression resolves to
 * a number, or `undefined` when a referenced signal or window has no value;
 * undefined propagates so a rule built on missing data skips instead of firing.
 */
import type { DayOfWeek, Expr } from './types'
import type { WindowStore } from './windows'

export interface EvalContext {
  signal: (key: string) => number | undefined
  windows: WindowStore
  nowMs: number
  /** Minutes since local midnight in the unit's timezone. */
  nowMinutes: number
  dayOfWeek: DayOfWeek
  /** Local yyyy-mm-dd; keys once-per-day trigger state. */
  dateKey: string
  /** Tracks how long `sustained` sub-conditions have held, keyed by their position in the tree. */
  sustain: SustainTracker
}

/** Start of the current true streak per key; a false or unknown sample resets it. */
export class SustainTracker {
  private readonly since = new Map<string, number>()

  held(key: string, value: boolean | undefined, forMin: number, nowMs: number): boolean | undefined {
    if (value === undefined) {
      this.since.delete(key)
      return undefined
    }
    if (!value) {
      this.since.delete(key)
      return false
    }
    const start = this.since.get(key) ?? nowMs
    this.since.set(key, start)
    return nowMs - start >= forMin * 60_000
  }

  /** Forget every key under a prefix (a rule was edited or removed). */
  reset(prefix: string): void {
    for (const k of [...this.since.keys()]) if (k.startsWith(prefix)) this.since.delete(k)
  }
}

export function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let out = value
  if (min !== undefined && out < min) out = min
  if (max !== undefined && out > max) out = max
  return out
}

export function evaluateExpr(expr: Expr, ctx: EvalContext): number | undefined {
  switch (expr.kind) {
    case 'literal':
      return expr.value
    case 'signal':
      return ctx.signal(expr.signal)
    case 'window':
      return ctx.windows.aggregate(expr.fn, expr.signal, expr.lastMin, ctx.nowMs)
    case 'binary': {
      const l = evaluateExpr(expr.left, ctx)
      const r = evaluateExpr(expr.right, ctx)
      if (l === undefined || r === undefined) return undefined
      switch (expr.op) {
        case '+': return l + r
        case '-': return l - r
        case '*': return l * r
        case '/': return r === 0 ? undefined : l / r
      }
      return undefined
    }
    case 'clamp': {
      const v = evaluateExpr(expr.value, ctx)
      if (v === undefined) return undefined
      return clamp(v, evaluateExpr(expr.min, ctx), evaluateExpr(expr.max, ctx))
    }
  }
}
