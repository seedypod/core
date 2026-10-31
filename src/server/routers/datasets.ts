import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { resolveWindow, summarize } from '../../datasets/export'
import { publicProcedure, router } from '../trpc'

export const WindowInput = z.object({ from: z.string().optional(), to: z.string().optional(), images: z.boolean().optional() })

export const datasetsRouter = router({
  summary: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/datasets/summary', tags: ['datasets'], summary: 'What a dataset export of this window would contain (download it from GET /api/datasets/export)' } })
    .input(WindowInput.optional())
    .output(z.object({ from: z.string(), to: z.string(), images: z.boolean(), captures: z.number(), analyses: z.number(), telemetry: z.number(), imageBytes: z.number() }))
    .query(({ ctx, input }) => {
      try {
        return summarize(ctx, resolveWindow(ctx.now?.() ?? new Date(), input ?? {}))
      }
      catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
      }
    }),
})
