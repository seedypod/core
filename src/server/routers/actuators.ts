import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { ActuatorId } from '../../hardware/contract'
import { ActuatorCommand, ActuatorState } from '../../hardware/contract'
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
})
