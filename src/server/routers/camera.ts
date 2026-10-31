import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

const Cam = z.enum(['upper', 'lower'])
const CaptureOut = z.object({ id: z.string(), camera: Cam, ts: z.string(), path: z.string(), bytes: z.number(), url: z.string() })

export const cameraRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/captures', tags: ['camera'] } })
    .input(z.object({ camera: Cam.optional(), limit: z.number().int().min(1).max(1000).default(100) }))
    .output(z.array(CaptureOut))
    .query(({ ctx, input }) => ctx.store.captures.list(input.camera, input.limit).map(c => ({ ...c, url: `/api/captures/${c.id}.jpg` }))),
  capture: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/camera/{camera}/capture', tags: ['camera'], summary: 'Take a still now' } })
    .input(z.object({ camera: Cam }))
    .output(CaptureOut)
    .mutation(async ({ ctx, input }) => {
      try {
        const c = await ctx.captures.capture(input.camera)
        ctx.events.emit({ kind: 'mutation', path: 'captures' })
        return { ...c, url: `/api/captures/${c.id}.jpg` }
      }
      catch (e) {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: (e as Error).message })
      }
    }),
})
