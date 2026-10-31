import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { CalibrationCommand, CalibrationResult, Reading, SensorId } from '../../hardware/contract'
import { publicProcedure, router } from '../trpc'

export const sensorsRouter = router({
  latest: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sensors', tags: ['sensors'], summary: 'Latest reading for every sensor' } })
    .output(z.partialRecord(SensorId, Reading))
    .query(({ ctx }) => ctx.hal.snapshot().sensors),
  read: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sensors/{id}', tags: ['sensors'] } })
    .input(z.object({ id: SensorId }))
    .output(Reading)
    .query(({ ctx, input }) => {
      const r = ctx.hal.snapshot().sensors[input.id]
      if (!r) throw new Error(`no reading for ${input.id}`)
      return r
    }),
  /** Calibration needs the probe sitting in a reference solution, so it is a deliberate human action — no MCP tool. */
  calibrate: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/sensors/{id}/calibrate', tags: ['sensors'], summary: 'Store a calibration point on a pH, EC or RTD probe (EZO)', description: 'pH: `mid` first, then optional `low`/`high`. EC: `dry`, then `single` or `low`+`high`. RTD: `single`. `clear` wipes stored points. `value` is the reference solution in the reported unit (pH, mS/cm, °C).' } })
    .input(CalibrationCommand.extend({ id: SensorId }))
    .output(CalibrationResult)
    .mutation(async ({ ctx, input }) => {
      const { id, ...cmd } = input
      const result = await ctx.hal.calibrate(id, cmd)
      if (!result.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: result.detail })
      ctx.events.emit({ kind: 'mutation', path: `sensors.${id}.calibration` })
      return result
    }),
})
