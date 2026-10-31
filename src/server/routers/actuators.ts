import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { ActuatorId } from '../../hardware/contract'
import { ActuatorCommand, ActuatorState } from '../../hardware/contract'
import { HalRefused } from '../../hardware/sim'
import { publicProcedure, router } from '../trpc'

async function set(ctx: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx'], id: z.infer<typeof ActuatorId>, cmd: z.infer<typeof ActuatorCommand>) {
  try {
    const state = await ctx.hal.setActuator(id, cmd)
    ctx.events.emit({ kind: 'mutation', path: `actuators.${id}` })
    return state
  }
  catch (e) {
    if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
    throw e
  }
}

export const lightRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/light', tags: ['light'] } })
    .output(ActuatorState.nullable())
    .query(({ ctx }) => ctx.hal.snapshot().actuators.light ?? null),
  set: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light', tags: ['light'], summary: 'Turn the grow light on/off and set brightness 0–100' } })
    .input(ActuatorCommand.omit({ durationS: true }))
    .output(ActuatorState)
    .mutation(async ({ ctx, input }) => {
      // A person set the light: it holds over Autopilot and the curve for a while (ADR-0020).
      const level = input.on === false ? 0 : input.level ?? (ctx.hal.snapshot().actuators.light?.level || 100)
      try {
        const state = await ctx.light.setManual(level)
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
    .output(z.object({ source: z.enum(['manual', 'autopilot', 'schedule']).nullable(), level: z.number().nullable(), leaseId: z.string().nullable(), manualUntil: z.string().nullable(), schedule: z.number().nullable() }))
    .query(({ ctx }) => ctx.light.status()),
  resume: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light/resume', tags: ['light'], summary: 'End a manual hold and hand the light back to Autopilot or the schedule' } })
    .output(z.object({ source: z.enum(['manual', 'autopilot', 'schedule']).nullable(), level: z.number().nullable(), leaseId: z.string().nullable(), manualUntil: z.string().nullable(), schedule: z.number().nullable() }))
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
