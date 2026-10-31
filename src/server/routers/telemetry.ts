import { z } from 'zod'
import { SensorId } from '../../hardware/contract'
import { LIGHT_HOURS_KEY } from '../../telemetry/recorder'
import { publicProcedure, router } from '../trpc'

export const telemetryRouter = router({
  history: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/telemetry/{sensor}', tags: ['sensors'], summary: 'Downsampled history for a sensor' } })
    .input(z.object({ sensor: SensorId, hours: z.number().min(1).max(24 * 90).default(24), maxPoints: z.number().int().min(10).max(2000).default(300) }))
    .output(z.array(z.object({ ts: z.string(), value: z.number() })))
    .query(({ ctx, input }) => {
      const now = (ctx.now ?? (() => new Date()))()
      const from = new Date(now.getTime() - input.hours * 3_600_000).toISOString()
      return ctx.store.telemetry.range(input.sensor, from, now.toISOString(), input.maxPoints).map(p => ({ ts: p.ts, value: p.value }))
    }),
  lightHours: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/telemetry/light-hours', tags: ['sensors'], summary: 'Cumulative grow-light hours (LED aging)' } })
    .output(z.object({ hours: z.number(), ratedHours: z.number(), pctUsed: z.number() }))
    .query(({ ctx }) => {
      const hours = ctx.store.counters.get(LIGHT_HOURS_KEY)
      const ratedHours = 25_000 // typical L70 for horticultural LED bars; refine in knowledge/
      return { hours: Math.round(hours * 10) / 10, ratedHours, pctUsed: Math.round((hours / ratedHours) * 1000) / 10 }
    }),
})
