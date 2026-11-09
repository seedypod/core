import { z } from 'zod'
import { setupReport } from '../../care/setup'
import { publicProcedure, router } from '../trpc'

const SetupIssue = z.object({
  id: z.enum(['no_light_schedule', 'no_pump_schedule', 'water_sensor_absent', 'water_sensor_suspect']),
  alert: z.string(),
  title: z.string(),
  detail: z.string(),
  fix: z.string(),
})

export const careRouter = router({
  setup: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/care/setup', tags: ['care'], summary: 'Setup check (ADR-0029): pods planted with no light or pump schedule on, and a tank level sensor that is absent or suspect' } })
    .output(z.object({ planted: z.number(), issues: z.array(SetupIssue), summary: z.string() }))
    .query(({ ctx }) => setupReport(ctx.store, ctx.hal.snapshot())),
})
