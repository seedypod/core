import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { backtest, summarize } from '../../autopilot/backtest'
import { ActionSchema, ConditionSchema, RuleInput, TriggerSchema } from '../../autopilot/schema'
import { catalog } from '../../autopilot/signals'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Rule = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  dryRun: z.boolean(),
  priority: z.number(),
  cooldownMin: z.number().nullable(),
  trigger: TriggerSchema,
  conditions: ConditionSchema,
  actions: z.array(ActionSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
const Outcome = z.enum(['fired', 'skipped', 'clamped', 'dry_run', 'refused', 'error'])
const Run = z.object({ id: z.number(), automationId: z.number(), firedAt: z.string(), outcome: Outcome, detail: z.unknown() })
const RuleWithLast = Rule.extend({ lastRun: Run.nullable() })
const ActionResult = z.object({
  kind: z.string(),
  raw: z.number().optional(),
  value: z.number().optional(),
  clamped: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  sent: z.boolean().optional(),
  antiThrash: z.boolean().optional(),
  skipped: z.string().optional(),
  refused: z.string().optional(),
  error: z.string().optional(),
})
const BacktestOut = z.object({
  from: z.string(),
  to: z.string(),
  stepMin: z.number(),
  times: z.array(z.string()),
  traces: z.array(z.object({ key: z.string(), label: z.string(), unit: z.string(), values: z.array(z.number().nullable()) })),
  liveOnly: z.array(z.string()),
  fires: z.array(z.object({ at: z.string(), outcome: Outcome, actions: z.array(ActionResult) })),
  suppressed: z.array(z.object({ at: z.string(), reason: z.string() })),
  summary: z.object({ fires: z.number(), suppressed: z.number(), unknownSteps: z.number(), disabledAt: z.string().nullable() }),
})

const Summary = z.object({
  id: z.number(),
  days: z.number(),
  wouldFire: z.number(),
  suppressed: z.number(),
  disabledAt: z.string().nullable(),
  watch: z.object({ key: z.string(), label: z.string(), unit: z.string(), op: z.enum(['>', '>=', '<', '<=', '==', '!=']), threshold: z.number(), extreme: z.number().nullable() }).nullable(),
  spark: z.array(z.number().nullable()),
  fireAt: z.array(z.number()),
  liveOnly: z.array(z.string()),
})

const ts = (ctx: Context) => (ctx.now?.() ?? new Date()).toISOString()

function changed(ctx: Context) {
  ctx.events.emit({ kind: 'mutation', path: 'automations' })
  // Evaluate at once so an edit, an arm or the kill switch takes effect without waiting for the tick.
  void ctx.autopilot.tick()
}

function must<T>(v: T | null, id: number): T {
  if (v === null) throw new TRPCError({ code: 'NOT_FOUND', message: `no automation ${id}` })
  return v
}

/** Autopilot (ADR-0020): reactive WHEN/IF/THEN rules, their audit log and backtests. */
export const automationsRouter = router({
  catalog: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/signals', tags: ['autopilot'], summary: 'Signals rules can read, with units; liveOnly ones are unknown in a backtest' } })
    .output(z.array(z.object({ key: z.string(), label: z.string(), unit: z.string(), group: z.string(), liveOnly: z.boolean() })))
    .query(() => catalog()),
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations', tags: ['autopilot'] } })
    .output(z.array(RuleWithLast))
    .query(({ ctx }) => ctx.store.automations.list().map(r => ({ ...r, lastRun: ctx.store.automations.runs({ automationId: r.id, limit: 1 })[0] ?? null }))),
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/status', tags: ['autopilot'], summary: 'Kill switch, last tick, live light leases and per-rule state' } })
    .output(z.object({
      enabled: z.boolean(),
      lastTickAt: z.string().nullable(),
      leases: z.array(z.object({ id: z.string(), level: z.number(), expiresAt: z.string() })),
      rules: z.array(z.object({ id: z.number(), condition: z.boolean().nullable(), lastFiredAt: z.string().nullable(), actionsLastHour: z.number(), cooldownUntil: z.string().nullable() })),
      light: z.object({ source: z.enum(['manual', 'autopilot', 'schedule']).nullable(), level: z.number().nullable(), leaseId: z.string().nullable(), manualUntil: z.string().nullable(), schedule: z.number().nullable() }),
    }))
    .query(({ ctx }) => ({ ...ctx.autopilot.status(), light: ctx.light.status() })),
  runs: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/runs', tags: ['autopilot'], summary: 'The audit log, newest first: every evaluation where a rule\'s trigger was active' } })
    .input(z.object({ automationId: z.number().int().optional(), limit: z.number().int().min(1).max(1000).default(100) }))
    .output(z.array(Run))
    .query(({ ctx, input }) => ctx.store.automations.runs(input)),
  // Static path: must come before /automations/{id}.
  backtests: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/backtests', tags: ['autopilot'], summary: 'Every rule replayed over the last days of recorded history, boiled down to a line and a sparkline' } })
    .input(z.object({ days: z.number().int().min(1).max(14).default(7) }).optional())
    .output(z.array(Summary))
    .query(async ({ ctx, input }) => {
      const to = (ctx.now?.() ?? new Date()).getTime()
      const days = input?.days ?? 7
      const out = []
      // One at a time: each replay drives its own engine over the store.
      for (const rule of ctx.store.automations.list()) {
        out.push({ id: rule.id, ...summarize(await backtest(ctx.store, { rule, fromMs: to - days * 86_400_000, toMs: to, stepMin: 15 }), rule) })
      }
      return out
    }),
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/{id}', tags: ['autopilot'] } })
    .input(z.object({ id: z.number().int() }))
    .output(Rule)
    .query(({ ctx, input }) => must(ctx.store.automations.get(input.id), input.id)),
  create: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations', tags: ['autopilot'], summary: 'Create a rule. New rules start in dry-run unless dryRun is false.' } })
    .input(RuleInput)
    .output(Rule)
    .mutation(({ ctx, input }) => {
      const r = ctx.store.automations.create(input, ts(ctx))
      changed(ctx)
      return r
    }),
  update: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/automations/{id}', tags: ['autopilot'] } })
    .input(RuleInput.partial().extend({ id: z.number().int() }))
    .output(Rule)
    .mutation(({ ctx, input }) => {
      const { id, ...patch } = input
      const r = must(ctx.store.automations.update(id, patch, ts(ctx)), id)
      changed(ctx)
      return r
    }),
  remove: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/automations/{id}', tags: ['autopilot'] } })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.automations.remove(input.id)
      ctx.store.alerts.clear(`autopilot_${input.id}`, ts(ctx))
      changed(ctx)
      return { removed }
    }),
  setGlobal: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/autopilot/enabled', tags: ['autopilot'], summary: 'The kill switch: off stops every rule and releases the light' } })
    .input(z.object({ enabled: z.boolean() }))
    .output(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.store.settings.update({ autopilotEnabled: input.enabled })
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      changed(ctx)
      return { enabled: input.enabled }
    }),
  backtest: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations/backtest', tags: ['autopilot'], summary: 'Replay a saved rule (id) or a draft (rule) over recorded history without touching hardware' } })
    .input(z.object({
      id: z.number().int().optional(),
      rule: RuleInput.optional(),
      hours: z.number().int().min(1).max(24 * 14).default(24),
      stepMin: z.number().int().min(1).max(60).default(5),
    }))
    .output(BacktestOut)
    .mutation(async ({ ctx, input }) => {
      const rule = input.rule ?? (input.id !== undefined ? must(ctx.store.automations.get(input.id), input.id) : null)
      if (!rule) throw new TRPCError({ code: 'BAD_REQUEST', message: 'pass a rule id or a draft rule' })
      const to = (ctx.now?.() ?? new Date()).getTime()
      return backtest(ctx.store, { rule, fromMs: to - input.hours * 3_600_000, toMs: to, stepMin: input.stepMin })
    }),
})
