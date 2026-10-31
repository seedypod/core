import { z } from 'zod'
import { podTrends } from '../../vision/analyze'
import { publicProcedure, router } from '../trpc'

const Trend = z.object({ slot: z.number(), green: z.number().nullable(), verdict: z.enum(['growing', 'stalled', 'declining', 'unknown']), slope: z.number(), samples: z.number() })

export const visionRouter = router({
  podTrends: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods', tags: ['vision'], summary: 'Per-pod green-area trend from camera stills (classical CV)' } })
    .output(z.array(Trend))
    .query(({ ctx }) => podTrends(ctx.store)),
  podSeries: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods/{slot}', tags: ['vision'] } })
    .input(z.object({ slot: z.number().int().min(1).max(60) }))
    .output(z.array(z.object({ ts: z.string(), green: z.number(), captureId: z.string() })))
    .query(({ ctx, input }) => ctx.store.podGrowth.series(input.slot).map(p => ({ ts: p.ts, green: p.green, captureId: p.captureId }))),
})
