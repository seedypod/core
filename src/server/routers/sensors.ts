import { z } from 'zod'
import { Reading, SensorId } from '../../hardware/contract'
import { publicProcedure, router } from '../trpc'

export const sensorsRouter = router({
  latest: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sensors', tags: ['sensors'], summary: 'Latest reading for every sensor' } })
    .output(z.record(SensorId, Reading))
    .query(({ ctx }) => ctx.hal.snapshot().sensors as Record<z.infer<typeof SensorId>, z.infer<typeof Reading>>),
  read: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sensors/{id}', tags: ['sensors'] } })
    .input(z.object({ id: SensorId }))
    .output(Reading)
    .query(({ ctx, input }) => {
      const r = ctx.hal.snapshot().sensors[input.id]
      if (!r) throw new Error(`no reading for ${input.id}`)
      return r
    }),
})
