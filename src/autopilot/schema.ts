/** zod schemas for the rule AST, validated at the API boundary (ADR-0020). */
import { z } from 'zod'
import type { Condition, Expr } from './types'

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')
const SignalKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'a catalog signal such as sensor.ph')
export const DayOfWeek = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])

export const ExprSchema: z.ZodType<Expr> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.number().finite() }),
  z.object({ kind: z.literal('signal'), signal: SignalKey }),
  z.object({ kind: z.literal('window'), fn: z.enum(['avg', 'min', 'max', 'sum', 'count']), signal: SignalKey, lastMin: z.number().int().min(1).max(1440) }),
  z.object({ kind: z.literal('binary'), op: z.enum(['+', '-', '*', '/']), left: ExprSchema, right: ExprSchema }),
  z.object({ kind: z.literal('clamp'), value: ExprSchema, min: ExprSchema, max: ExprSchema }),
]))

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('and'), conditions: z.array(ConditionSchema).max(20) }),
  z.object({ kind: z.literal('or'), conditions: z.array(ConditionSchema).min(1).max(20) }),
  z.object({ kind: z.literal('not'), condition: ConditionSchema }),
  z.object({ kind: z.literal('compare'), op: z.enum(['>', '>=', '<', '<=', '==', '!=']), left: ExprSchema, right: ExprSchema }),
  z.object({ kind: z.literal('between'), subject: ExprSchema, min: ExprSchema, max: ExprSchema }),
  z.object({ kind: z.literal('timeBetween'), start: HHMM, end: HHMM }),
  z.object({ kind: z.literal('onDays'), days: z.array(DayOfWeek).min(1) }),
  z.object({ kind: z.literal('sustained'), condition: ConditionSchema, forMin: z.number().int().min(1).max(1440) }),
]))

export const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tick'), everyMin: z.number().int().min(1).max(1440) }),
  z.object({ kind: z.literal('signalChange'), signal: SignalKey }),
  z.object({ kind: z.literal('timeOfDay'), at: HHMM, days: z.array(DayOfWeek).min(1).optional() }),
])

const Doser = z.enum(['dose_1', 'dose_2', 'dose_3'])

export const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notify'), message: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal('setLight'),
    level: ExprSchema,
    clamp: z.object({ min: z.number().min(0).max(100), max: z.number().min(0).max(100) }).refine(c => c.min <= c.max, 'min above max').optional(),
    mode: z.enum(['policy', 'one-shot']).optional(),
    holdMinutes: z.number().int().min(1).max(1440).optional(),
  }),
  z.object({ kind: z.literal('runPump'), durationS: ExprSchema, level: z.number().min(1).max(100).optional() }),
  z.object({ kind: z.literal('stopPump') }),
  z.object({ kind: z.literal('dose'), doser: Doser, durationS: ExprSchema }),
  z.object({ kind: z.literal('setPodStatus'), slot: z.number().int().min(1).max(30), status: z.enum(['empty', 'seeded', 'growing', 'harvest', 'attention']) }),
])

export const RuleInput = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  cooldownMin: z.number().int().min(0).max(10_080).nullable().default(null),
  trigger: TriggerSchema,
  conditions: ConditionSchema,
  actions: z.array(ActionSchema).min(1).max(10),
})
export type RuleInput = z.infer<typeof RuleInput>
