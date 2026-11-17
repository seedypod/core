import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { ActuatorId } from '../../hardware/contract'
import { ActuatorCommand, ActuatorState, DryGuard, Limits, PumpRun } from '../../hardware/contract'
import { HalRefused } from '../../hardware/sim'
import { publicProcedure, router } from '../trpc'

async function set(ctx: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx'], id: z.infer<typeof ActuatorId>, cmd: z.infer<typeof ActuatorCommand>) {
  try {
    const state = await ctx.hal.setActuator(id, cmd)
    // A command that starts the pump says so, so the UI can tell a run someone started from a Stop.
    const starts = id === 'pump' && (cmd.on === true || (cmd.on === undefined && (cmd.level ?? 0) > 0))
    ctx.events.emit({ kind: 'mutation', path: starts ? 'actuators.pump.on' : `actuators.${id}` })
    return state
  }
  catch (e) {
    if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
    throw e
  }
}

const LightOwner = z.object({ source: z.enum(['manual', 'autopilot', 'schedule']).nullable(), level: z.number().nullable(), leaseId: z.string().nullable(), manualUntil: z.string().nullable(), schedule: z.number().nullable() })
/** When a hand's hold ends: a time ahead, or null for until someone resumes. */
const HoldUntil = z.string().datetime({ offset: true }).nullable()

/** A hold's end as epoch ms (null stays null); one already past is refused. */
function holdEnd(until: string | null, now: number): number | null {
  if (until === null) return null
  const at = Date.parse(until)
  if (at <= now) throw new TRPCError({ code: 'BAD_REQUEST', message: 'until is already past' })
  return at
}

export const lightRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/light', tags: ['light'] } })
    .output(ActuatorState.nullable())
    .query(({ ctx }) => ctx.hal.snapshot().actuators.light ?? null),
  set: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light', tags: ['light'], summary: 'Turn the grow light on/off and set brightness 0–100' } })
    .input(ActuatorCommand.omit({ durationS: true }).extend({ until: HoldUntil.optional().describe('When the hold ends; null holds until resumed; left out, 30 minutes') }))
    .output(ActuatorState)
    .mutation(async ({ ctx, input }) => {
      // A person set the light: it holds over Autopilot and the curve for a while (ADR-0020).
      const level = input.on === false ? 0 : input.level ?? (ctx.hal.snapshot().actuators.light?.level || 100)
      const until = input.until === undefined ? undefined : holdEnd(input.until, (ctx.now ?? (() => new Date()))().getTime())
      try {
        const state = await ctx.light.setManual(level, until)
        ctx.events.emit({ kind: 'mutation', path: 'actuators.light' })
        return state
      }
      catch (e) {
        if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
        throw e
      }
    }),
  owner: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/light/owner', tags: ['light'], summary: 'Who controls the light now: manual hold, Autopilot or the schedule' } })
    .output(LightOwner)
    .query(({ ctx }) => ctx.light.status()),
  hold: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light/hold', tags: ['light'], summary: 'Change when a manual hold ends: a time, or null to hold until resumed' } })
    .input(z.object({ until: HoldUntil }))
    .output(LightOwner)
    .mutation(({ ctx, input }) => {
      if (!ctx.light.holdUntil(holdEnd(input.until, (ctx.now ?? (() => new Date()))().getTime()))) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the light isn\'t held by hand' })
      ctx.events.emit({ kind: 'mutation', path: 'actuators.light' })
      return ctx.light.status()
    }),
  resume: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light/resume', tags: ['light'], summary: 'End a manual hold and hand the light back to Autopilot or the schedule' } })
    .output(LightOwner)
    .mutation(async ({ ctx }) => {
      await ctx.light.resume()
      await ctx.light.idle()
      ctx.events.emit({ kind: 'mutation', path: 'actuators.light' })
      return ctx.light.status()
    }),
})

export const pumpRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pump', tags: ['pump'] } })
    .output(ActuatorState.nullable())
    .query(({ ctx }) => ctx.hal.snapshot().actuators.pump ?? null),
  set: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump', tags: ['pump'], summary: 'Run the pump; every run is bounded by the HAL max-run limit and the dry-run interlock' } })
    .input(ActuatorCommand)
    .output(ActuatorState)
    .mutation(({ ctx, input }) => set(ctx, 'pump', input)),
  runOnce: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/run-once', tags: ['pump'], summary: 'Run the pump for N seconds at a speed' } })
    .input(z.object({ durationS: z.number().int().positive(), level: z.number().min(1).max(100).optional() }))
    .output(ActuatorState)
    .mutation(({ ctx, input }) => set(ctx, 'pump', { on: true, level: input.level, durationS: input.durationS })),
  stop: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/stop', tags: ['pump'] } })
    .input(z.void())
    .output(ActuatorState)
    .mutation(({ ctx }) => set(ctx, 'pump', { on: false })),
  // The dry-run guard: its spin-up grace, its current cutoff and which guard
  // runs. The unit holds the numbers to hal.toml's bounds and may lock the guard;
  // nothing here can turn it off.
  setGuard: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/guard', tags: ['pump'], summary: 'Change the pump dry-run guard: which signals stop a dry pump (tank level, pump current or both), the current cutoff in A, the spin-up grace in ms, the tank-level cutoff in cm from the sensor and how long the level must stay past it in ms; the unit holds the numbers to the bounds in its hal.toml' } })
    .input(z.object({ guard: DryGuard.optional(), currentA: z.number().positive().max(10).optional(), graceMs: z.number().int().min(0).max(10_000).optional(), waterLowCm: z.number().positive().max(100).optional(), waterLowHoldMs: z.number().int().min(0).max(60_000).optional() }).refine(i => Object.values(i).some(v => v !== undefined), 'nothing to change'))
    .output(Limits)
    .mutation(async ({ ctx, input }) => {
      try {
        const limits = await ctx.hal.setPumpGuard({ dryGuard: input.guard, dryCurrentA: input.currentA, dryGraceMs: input.graceMs, waterLowCm: input.waterLowCm, waterLowHoldMs: input.waterLowHoldMs })
        ctx.events.emit({ kind: 'mutation', path: 'pump.guard' })
        return limits
      }
      catch (e) {
        if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
        throw e
      }
    }),
  lastRun: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pump/last-run', tags: ['pump'], summary: 'The pump\'s last run as the unit recorded it: its first 12 s of current and supply, its wet current, how it ended and the tank as it ended; null until a run ends' } })
    .input(z.void())
    .output(PumpRun.nullable())
    .query(({ ctx }) => ctx.hal.snapshot().lastRun ?? null),
  setDryGrace: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/dry-grace', tags: ['pump'], summary: 'Set how long after a start the pump current isn\'t checked, while the pump spins up; the unit holds it to the bounds in its hal.toml' } })
    .input(z.object({ ms: z.number().int().min(0).max(10_000) }))
    .output(Limits)
    .mutation(async ({ ctx, input }) => {
      try {
        const limits = await ctx.hal.setPumpGuard({ dryGraceMs: input.ms })
        ctx.events.emit({ kind: 'mutation', path: 'pump.dryGrace' })
        return limits
      }
      catch (e) {
        if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
        throw e
      }
    }),
})
