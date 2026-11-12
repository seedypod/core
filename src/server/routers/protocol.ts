import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { advanceProtocol, holdProtocol, protocolReport, ProtocolError, releaseProtocol, setProtocolThen } from '../../care/protocol'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Citation = z.object({ note: z.string(), section: z.string(), url: z.string() })
const Cited = z.object({ text: z.string(), citation: Citation })
const StageId = z.enum(['germination', 'seedlings', 'young', 'maintenance'])

const Stage = z.object({
  id: StageId,
  name: z.string(),
  from: z.number(),
  to: z.number().nullable(),
  startsOn: z.string().nullable(),
  state: z.enum(['done', 'current', 'next']),
  water: z.object({ presetId: z.string(), name: z.string(), runs: z.array(z.number()), durationS: z.number(), days: z.number(), weekly: z.boolean(), citation: Citation }),
  light: z.object({ presetId: z.string(), name: z.string() }).nullable(),
  feed: Cited,
  checks: z.array(Cited),
  rationale: z.string(),
  citation: Citation,
  change: z.string().nullable(),
})

export const ProtocolOut = z.object({
  following: z.boolean(),
  protocol: z.object({ id: z.enum(['greens-herbs', 'fruiting']), name: z.string(), fixed: z.boolean() }),
  cycleId: z.string().nullable(),
  sownOn: z.string().nullable(),
  daysSinceSowing: z.number().nullable(),
  day: z.number().nullable(),
  stage: StageId.nullable(),
  dayInStage: z.number().nullable(),
  canAdvance: z.boolean(),
  hold: z.object({ stageId: z.string(), since: z.string().nullable(), days: z.number() }).nullable(),
  then: z.object({ kind: z.enum(['stay', 'schedule', 'remind']), scheduleId: z.string().nullable(), scheduleName: z.string().nullable(), harvestDay: z.number().nullable(), harvestOn: z.string().nullable(), done: z.boolean() }),
  water: z.enum(['preset', 'schedule', 'edited', 'none']),
  activeScheduleId: z.string().nullable(),
  stages: z.array(Stage),
  behind: z.array(z.object({ slot: z.number(), plant: z.string().nullable(), daysBehind: z.number() })),
})

const now = (ctx: Context) => (ctx.now ?? (() => new Date()))()

/**
 * Run a protocol action, refusing what it can't do; tell the care engine the
 * grow cycle moved, which it acts on as the event is emitted; then report, so
 * the answer has any watering the engine moved.
 */
function act(ctx: Context, fn: () => void) {
  try {
    fn()
  }
  catch (err) {
    if (err instanceof ProtocolError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    throw err
  }
  ctx.events.emit({ kind: 'mutation', path: 'grow' })
  return protocolReport(ctx.store, now(ctx))
}

export const protocolRouter = router({
  current: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/protocol', tags: ['grow'], summary: 'The grow protocol (ADR-0030): its stages with the water, light, feed and checks each sets and the date each starts on the unit\'s calendar; the current stage and day, hold, what comes after maintenance, whether the pump cycles are still the protocol\'s, and pods sown later than it' } })
    .output(ProtocolOut)
    .query(({ ctx }) => protocolReport(ctx.store, now(ctx))),
  hold: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/protocol/hold', tags: ['grow'], summary: 'Hold the current stage: it stays until release, and later stages start that many days later' } })
    .input(z.void())
    .output(ProtocolOut)
    .mutation(({ ctx }) => act(ctx, () => holdProtocol(ctx.store, now(ctx)))),
  release: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/protocol/release', tags: ['grow'], summary: 'Release a hold: the stage resumes where it was held' } })
    .input(z.void())
    .output(ProtocolOut)
    .mutation(({ ctx }) => act(ctx, () => releaseProtocol(ctx.store, now(ctx)))),
  advance: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/protocol/advance', tags: ['grow'], summary: 'Advance to the next stage now; the care engine moves the watering on. Refused in maintenance, the last stage' } })
    .input(z.void())
    .output(ProtocolOut)
    .mutation(({ ctx }) => act(ctx, () => {
      advanceProtocol(ctx.store, now(ctx))
    })),
  setThen: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/protocol/then', tags: ['grow'], summary: 'Choose what comes after: stay in maintenance; switch to one of Your schedules now, or when maintenance begins; or a reminder at the crops\' first harvest' } })
    .input(z.object({ kind: z.enum(['stay', 'schedule', 'remind']), scheduleId: z.string().min(1).optional(), when: z.enum(['now', 'maintenance']).default('maintenance') }))
    .output(ProtocolOut)
    .mutation(({ ctx, input }) => act(ctx, () => {
      const switched = setProtocolThen(ctx.store, now(ctx), input)
      if (switched) ctx.events.emit({ kind: 'schedule', action: 'changed', id: `library:${switched}` })
    })),
})
