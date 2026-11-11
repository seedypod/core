import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { cycleDay } from '../../grow/grow'
import { harvestOutlook } from '../../grow/harvest'
import { publicProcedure, router } from '../trpc'

const Stage = z.enum(['germination', 'seedling', 'vegetative', 'harvest', 'ended'])
const Cycle = z.object({ id: z.string(), startedAt: z.string(), endedAt: z.string().nullable(), stage: Stage, notes: z.string(), issued: z.array(z.string()) })
const PodStatus = z.enum(['empty', 'seeded', 'growing', 'harvest', 'attention'])
const PodOut = z.object({ slot: z.number(), plant: z.string().nullable(), plantedAt: z.string().nullable(), status: PodStatus, notes: z.string(), updatedAt: z.string(), statusSince: z.string().nullable(), lastHarvestAt: z.string().nullable() })
const Outlook = z.object({
  slot: z.number(),
  plant: z.string().nullable(),
  state: z.enum(['ready', 'soon', 'growing', 'unknown']),
  ageDays: z.number().nullable(),
  cover: z.number().nullable(),
  targetCover: z.number(),
  coverPerDay: z.number().nullable(),
  window: z.object({ start: z.number(), end: z.number(), source: z.enum(['profile', 'camera']) }).nullable(),
  daysToReady: z.number().nullable(),
  daysLeft: z.number().nullable(),
  profile: z.string().nullable(),
  reason: z.string(),
})

export const growRouter = router({
  current: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/grow', tags: ['grow'] } })
    .output(z.object({ cycle: Cycle.nullable(), day: z.number().nullable() }))
    .query(({ ctx }) => {
      const cycle = ctx.store.grow.current()
      return { cycle, day: cycle ? cycleDay(cycle, (ctx.now ?? (() => new Date()))()) : null }
    }),
  start: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/start', tags: ['grow'], summary: 'Start a new grow cycle (ends any open one); startedAt backdates it to the sowing day' } })
    .input(z.object({ notes: z.string().default(''), startedAt: z.string().refine(s => Number.isFinite(Date.parse(s)), 'startedAt must be a date').optional() }))
    .output(Cycle)
    .mutation(({ ctx, input }) => {
      const now = (ctx.now ?? (() => new Date()))()
      // A cycle that started before seedypod knew of it (the pods were sown first), never one in the future.
      const at = input.startedAt ? new Date(input.startedAt) : now
      if (at.getTime() > now.getTime()) throw new TRPCError({ code: 'BAD_REQUEST', message: 'startedAt is in the future' })
      const c = ctx.store.grow.start(at.toISOString(), input.notes)
      ctx.events.emit({ kind: 'mutation', path: 'grow' })
      return c
    }),
  setStage: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/stage', tags: ['grow'] } })
    .input(z.object({ stage: Stage }))
    .output(Cycle.nullable())
    .mutation(({ ctx, input }) => {
      const c = ctx.store.grow.setStage(input.stage, (ctx.now ?? (() => new Date()))().toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'grow' })
      return c
    }),
  end: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/end', tags: ['grow'] } })
    .input(z.void())
    .output(Cycle.nullable())
    .mutation(({ ctx }) => {
      const c = ctx.store.grow.end((ctx.now ?? (() => new Date()))().toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'grow' })
      return c
    }),
  history: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/grow/history', tags: ['grow'] } })
    .output(z.array(Cycle))
    .query(({ ctx }) => ctx.store.grow.history()),
  pods: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pods', tags: ['grow'] } })
    .output(z.array(PodOut))
    .query(({ ctx }) => ctx.store.pods.list()),
  updatePod: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/pods/{slot}', tags: ['grow'] } })
    .input(z.object({ slot: z.number().int().min(1).max(60), plant: z.string().nullable().optional(), plantedAt: z.string().nullable().optional(), status: PodStatus.optional(), notes: z.string().optional() }))
    .output(PodOut)
    .mutation(({ ctx, input }) => {
      const { slot, ...patch } = input
      const p = ctx.store.pods.update(slot, patch, (ctx.now ?? (() => new Date()))().toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'pods' })
      return p
    }),
  swapPods: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pods/swap', tags: ['grow'], summary: 'Swap what two pods hold (plant, sow date, status, notes, last cut), after moving their yCubes; camera history stays with each pod position' } })
    .input(z.object({ a: z.number().int().min(1).max(60), b: z.number().int().min(1).max(60) }))
    .output(z.array(PodOut))
    .mutation(({ ctx, input }) => {
      const pods = ctx.store.pods.list()
      const a = pods.find(p => p.slot === input.a)
      const b = pods.find(p => p.slot === input.b)
      if (!a || !b) throw new TRPCError({ code: 'NOT_FOUND', message: `no pod ${a ? input.b : input.a}` })
      if (a.slot === b.slot) return [a, b]
      const ts = (ctx.now ?? (() => new Date()))().toISOString()
      const holds = (p: typeof a) => ({ plant: p.plant, plantedAt: p.plantedAt, status: p.status, notes: p.notes, lastHarvestAt: p.lastHarvestAt })
      const out = [ctx.store.pods.update(a.slot, holds(b), ts), ctx.store.pods.update(b.slot, holds(a), ts)]
      ctx.events.emit({ kind: 'mutation', path: 'pods' })
      return out
    }),
  harvest: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/harvest', tags: ['grow'], summary: 'Harvest outlook per planted pod: ready, soon or growing, from leaf cover and any plant profile (ADR-0022)' } })
    .output(z.array(Outlook))
    .query(({ ctx }) => harvestOutlook(ctx.store, (ctx.now ?? (() => new Date()))())),
  markHarvested: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pods/{slot}/harvested', tags: ['grow'], summary: 'Record a cut: the pod goes back to growing and the camera counts only regrowth' } })
    .input(z.object({ slot: z.number().int().min(1).max(60) }))
    .output(PodOut)
    .mutation(({ ctx, input }) => {
      const ts = (ctx.now ?? (() => new Date()))().toISOString()
      const p = ctx.store.pods.update(input.slot, { status: 'growing', lastHarvestAt: ts }, ts)
      ctx.events.emit({ kind: 'mutation', path: 'pods' })
      return p
    }),
})
