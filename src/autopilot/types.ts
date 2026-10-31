/**
 * Autopilot rule model — the WHEN / IF / THEN AST (ADR-0020). Ported from
 * sleepypod `src/automation/types.ts` (AGPL-3.0, same owner); the actions are
 * seedypod's: the light, the pump, the dosers and pods instead of bed sides.
 */

export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!='
export type BinaryOp = '+' | '-' | '*' | '/'
export type WindowFn = 'avg' | 'min' | 'max' | 'sum' | 'count'

/** Evaluates to a number, or `undefined` when a referenced signal has no value (which propagates). */
export type Expr
  = | { kind: 'literal', value: number }
    | { kind: 'signal', signal: string }
    | { kind: 'window', fn: WindowFn, signal: string, lastMin: number }
    | { kind: 'binary', op: BinaryOp, left: Expr, right: Expr }
    | { kind: 'clamp', value: Expr, min: Expr, max: Expr }

/** Evaluates to true / false / undefined ("unknown": a signal was missing). */
export type Condition
  = | { kind: 'and', conditions: Condition[] }
    | { kind: 'or', conditions: Condition[] }
    | { kind: 'not', condition: Condition }
    | { kind: 'compare', op: CompareOp, left: Expr, right: Expr }
    | { kind: 'between', subject: Expr, min: Expr, max: Expr }
    | { kind: 'timeBetween', start: string, end: string } // HH:MM, wraps past midnight
    | { kind: 'onDays', days: DayOfWeek[] }
    /** True once the inner condition has held continuously for `forMin` minutes. */
    | { kind: 'sustained', condition: Condition, forMin: number }

export type Trigger
  = | { kind: 'tick', everyMin: number }
    | { kind: 'signalChange', signal: string }
    | { kind: 'timeOfDay', at: string, days?: DayOfWeek[] } // HH:MM

export type DoserId = 'dose_1' | 'dose_2' | 'dose_3'
export type PodStatus = 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention'

/**
 * THEN. Hardware actions go through the light arbiter or hald, whose guards
 * (dry-run interlock, max run/duty, dose caps) still apply.
 */
export type Action
  = | { kind: 'notify', message: string }
    | {
      kind: 'setLight'
      level: Expr
      /** Layer-1 band inside 0–100. */
      clamp?: { min: number, max: number }
      /** `policy` re-asserts while the condition holds; `one-shot` holds for `holdMinutes`. */
      mode?: 'policy' | 'one-shot'
      holdMinutes?: number
    }
    | { kind: 'runPump', durationS: Expr, level?: number }
    | { kind: 'stopPump' }
    | { kind: 'dose', doser: DoserId, durationS: Expr }
    | { kind: 'setPodStatus', slot: number, status: PodStatus }

export interface AutomationRule {
  id: number
  name: string
  enabled: boolean
  /** Evaluate and log what would happen, without acting. New rules start here. */
  dryRun: boolean
  /** Higher wins when two rules want the light. */
  priority: number
  cooldownMin: number | null
  trigger: Trigger
  conditions: Condition
  actions: Action[]
}

export type RunOutcome = 'fired' | 'skipped' | 'clamped' | 'dry_run' | 'refused' | 'error'

/** Evaluator tick: telemetry arrives about once a minute and plants move slower. */
export const AUTOPILOT_TICK_MS = 60_000
/** Runaway guard: more actions than this in a rolling hour disables the rule. */
export const AUTOPILOT_MAX_ACTIONS_PER_HOUR = 12
/** Anti-thrash: a light lease is only moved when the level changes this much. */
export const AUTOPILOT_LIGHT_ANTI_THRASH = 2
/** One-shot light leases hold this long unless the action says otherwise. */
export const AUTOPILOT_DEFAULT_HOLD_MIN = 60
/** A `timeOfDay` trigger may still fire this many minutes after its slot. */
export const TIME_OF_DAY_GRACE_MIN = 10
