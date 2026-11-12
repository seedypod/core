import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

const Cam = z.enum(['upper', 'lower'])
const CaptureOut = z.object({ id: z.string(), camera: Cam, ts: z.string(), path: z.string(), bytes: z.number(), url: z.string() })
const PodIdOut = z.object({ camera: Cam, ts: z.string(), bytes: z.number(), url: z.string() })

export const cameraRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/captures', tags: ['camera'] } })
    .input(z.object({ camera: Cam.optional(), limit: z.number().int().min(1).max(1000).default(100) }))
    .output(z.array(CaptureOut))
    .query(({ ctx, input }) => ctx.store.captures.list(input.camera, input.limit).map(c => ({ ...c, url: `/api/captures/${c.id}.jpg` }))),
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/captures/{id}', tags: ['camera'], summary: 'One stored still by id; NOT_FOUND once pruned' } })
    .input(z.object({ id: z.string() }))
    .output(CaptureOut)
    .query(({ ctx, input }) => {
      const c = ctx.store.captures.get(input.id)
      if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: `no capture ${input.id}` })
      return { ...c, url: `/api/captures/${c.id}.jpg` }
    }),
  capture: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/camera/{camera}/capture', tags: ['camera'], summary: 'Take a still now' } })
    .input(z.object({ camera: Cam }))
    .output(CaptureOut)
    .mutation(async ({ ctx, input }) => {
      try {
        const c = await ctx.captures.capture(input.camera)
        return { ...c, url: `/api/captures/${c.id}.jpg` }
      }
      catch (e) {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: (e as Error).message })
      }
    }),
  capturePodId: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/camera/{camera}/podid', tags: ['camera'], summary: 'Take a full-size pod-ID still now (#224); not a capture, so not listed, scored or in the timelapse' } })
    .input(z.object({ camera: Cam }))
    .output(PodIdOut)
    .mutation(async ({ ctx, input }) => {
      try {
        const { still } = await ctx.captures.capturePodId(input.camera)
        return { camera: still.camera, ts: still.ts, bytes: still.bytes, url: `/api/camera/${still.camera}/podid.jpg` }
      }
      catch (e) {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: (e as Error).message })
      }
    }),
})
