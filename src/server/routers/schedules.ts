import { z } from 'zod'
import { lightLevelAt } from '../../scheduler/scheduler'
import { publicProcedure, router } from '../trpc'

const LightSpec = z.object({ setpoints: z.array(z.object({ minute: z.number().int().min(0).max(1439), level: z.number().min(0).max(100) })).max(24) })
const PumpSpec = z.object({ minute: z.number().int().min(0).max(1439), durationS: z.number().int().positive().max(3600), level: z.number().min(1).max(100).optional() })

/** trpc-to-openapi needs a ZodObject input, so the kind/spec pairing is checked in a refinement. */
export const ScheduleSchema = z.object({
  id: z.string().min(1), kind: z.enum(['light', 'pump']), name: z.string().min(1), enabled: z.boolean(), days: z.number().int().min(0).max(127),
  spec: z.union([LightSpec, PumpSpec]),
}).refine(s => (s.kind === 'light' ? 'setpoints' in s.spec : 'durationS' in s.spec), { message: 'spec does not match kind', path: ['spec'] })

const ScheduleOut = z.object({
  id: z.string(), kind: z.enum(['light', 'pump']), name: z.string(), enabled: z.boolean(), days: z.number(),
  spec: z.union([LightSpec, PumpSpec]), createdAt: z.string(), updatedAt: z.string(),
})

export const schedulesRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedules', tags: ['schedules'] } })
    .output(z.array(ScheduleOut))
    .query(({ ctx }) => ctx.store.schedules.list()),
  upsert: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/schedules/{id}', tags: ['schedules'], summary: 'Create or replace a light curve or pump cycle' } })
    .input(ScheduleSchema)
    .output(ScheduleOut)
    .mutation(({ ctx, input }) => {
      const row = ctx.store.schedules.upsert(input as Parameters<typeof ctx.store.schedules.upsert>[0])
      ctx.events.emit({ kind: 'schedule', action: 'changed', id: input.id })
      return row
    }),
  remove: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/schedules/{id}', tags: ['schedules'] } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.schedules.remove(input.id)
      ctx.events.emit({ kind: 'schedule', action: 'changed', id: input.id })
      return { removed }
    }),
  /** Preview a light curve as 96 samples (every 15 min) for charts. */
  previewCurve: publicProcedure
    .input(LightSpec)
    .output(z.array(z.object({ minute: z.number(), level: z.number().nullable() })))
    .query(({ input }) => Array.from({ length: 96 }, (_, i) => ({ minute: i * 15, level: lightLevelAt(input, i * 15) }))),
  recentRuns: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedules/runs', tags: ['schedules'] } })
    .output(z.array(z.object({ scheduleId: z.string(), key: z.string(), firedAt: z.string(), result: z.string() })))
    .query(({ ctx }) => ctx.store.schedules.recentRuns()),
})
