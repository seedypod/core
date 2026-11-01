import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { podTrends } from '../../vision/analyze'
import { publicProcedure, router } from '../trpc'

const Trend = z.object({ slot: z.number(), green: z.number().nullable(), verdict: z.enum(['growing', 'stalled', 'declining', 'unknown']), slope: z.number(), samples: z.number(), recent: z.array(z.number()) })
const Metric = z.object({ name: z.string(), label: z.string(), unit: z.string().optional(), description: z.string() })
const Source = z.enum(['device', 'remote'])
const Analyzer = z.object({
  id: z.string(),
  version: z.number(),
  label: z.string(),
  description: z.string(),
  metrics: z.array(Metric),
  runsOn: z.array(Source),
  source: Source,
  primary: z.boolean(),
  rows: z.number(),
  captures: z.number(),
  firstTs: z.string().nullable(),
  lastTs: z.string().nullable(),
})
const Status = z.object({
  running: z.string().nullable(),
  waiting: z.array(z.string()),
  dropped: z.number(),
  failed: z.number(),
  backfill: z.object({ analyzer: z.string(), done: z.number(), total: z.number() }).nullable(),
})
const Result = z.object({
  captureId: z.string(),
  ts: z.string(),
  camera: z.enum(['upper', 'lower']),
  analyzer: z.string(),
  version: z.number(),
  source: Source,
  slot: z.number(),
  metric: z.string(),
  value: z.number(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  artifact: z.string().nullable(),
})
const Point = z.object({ ts: z.string(), value: z.number(), captureId: z.string() })

export const visionRouter = router({
  podTrends: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods', tags: ['vision'], summary: 'Per-pod green-area trend from the primary analyser' } })
    .input(z.object({ analyzer: z.string().optional() }).optional())
    .output(z.array(Trend))
    .query(({ ctx, input }) => podTrends(ctx.store, 30, input?.analyzer)),
  podSeries: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods/{slot}', tags: ['vision'] } })
    .input(z.object({ slot: z.number().int().min(1).max(60) }))
    .output(z.array(z.object({ ts: z.string(), green: z.number(), captureId: z.string() })))
    .query(({ ctx, input }) => ctx.store.analyses.series({ analyzer: ctx.store.settings.get().primaryAnalyzer, slot: input.slot, metric: 'green_fraction' })
      .map(p => ({ ts: p.ts, green: p.value, captureId: p.captureId }))),
  analyzers: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/analyzers', tags: ['vision'], summary: 'Analysers on the unit and any that posted results, with row counts and which is primary' } })
    .output(z.array(Analyzer))
    .query(({ ctx }) => ctx.analysis.list()),
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/status', tags: ['vision'], summary: 'Analysis queue: running, waiting, dropped, failed, re-run progress' } })
    .output(Status)
    .query(({ ctx }) => ctx.analysis.status()),
  compare: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/compare/{slot}', tags: ['vision'], summary: 'One pod\'s series from every analyser@version, for side-by-side comparison' } })
    .input(z.object({ slot: z.number().int().min(1).max(60), metric: z.string().default('green_fraction'), limit: z.number().int().min(1).max(1000).default(200) }))
    .output(z.array(z.object({ analyzer: z.string(), version: z.number(), source: Source, points: z.array(Point) })))
    .query(({ ctx, input }) => ctx.store.analyses.stats()
      .map(s => ({ analyzer: s.analyzer, version: s.version, source: s.source, points: ctx.store.analyses.series({ analyzer: s.analyzer, version: s.version, slot: input.slot, metric: input.metric, limit: input.limit }) }))
      .filter(s => s.points.length > 0)),
  capture: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/captures/{captureId}', tags: ['vision'], summary: 'Every analyser\'s results for one capture' } })
    .input(z.object({ captureId: z.string() }))
    .output(z.array(Result))
    .query(({ ctx, input }) => ctx.store.analyses.forCapture(input.captureId)),
  setPrimary: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/vision/primary', tags: ['vision'], summary: 'Choose the analyser that drives pod trends' } })
    .input(z.object({ analyzer: z.string() }))
    .output(z.object({ analyzer: z.string() }))
    .mutation(({ ctx, input }) => {
      const known = ctx.analysis.list().find(a => a.id === input.analyzer && a.metrics.some(m => m.name === 'green_fraction'))
        ?? ctx.store.analyses.stats().find(s => s.analyzer === input.analyzer)
      if (!known) throw new TRPCError({ code: 'NOT_FOUND', message: `no analyser ${input.analyzer}` })
      ctx.store.settings.update({ primaryAnalyzer: input.analyzer })
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      return { analyzer: input.analyzer }
    }),
  rerun: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/vision/analyzers/{analyzer}/rerun', tags: ['vision'], summary: 'Re-score stored captures with one on-device analyser, in the background' } })
    .input(z.object({ analyzer: z.string(), limit: z.number().int().min(1).max(5000).default(2000) }))
    .output(z.object({ captures: z.number() }))
    .mutation(({ ctx, input }) => {
      try {
        return { captures: ctx.analysis.rerun(input.analyzer, input.limit) }
      }
      catch (e) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (e as Error).message })
      }
    }),
})
