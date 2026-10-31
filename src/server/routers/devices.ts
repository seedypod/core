import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DeviceInventory, DeviceResult } from '../../hardware/contract'
import { publicProcedure, router } from '../trpc'

const Target = z.object({ kind: z.string().min(1), addr: z.number().int().min(0).max(0x7f) })

/**
 * Sensor devices on the unit. hald owns the inventory (hal.toml + sensors
 * added here, ADR-0018); every kind is described by its `SensorKind`
 * descriptor, so clients need no per-kind code.
 */
export const devicesRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/devices', tags: ['devices'], summary: 'Configured sensor devices (with probe status) and the kinds that can be added' } })
    .output(DeviceInventory)
    .query(({ ctx }) => ctx.hal.snapshot().devices ?? { sensors: [], addable: [] }),
  addSensor: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/devices/sensors', tags: ['devices'], summary: 'Add a probe of an addable kind at an I²C address; it goes live without a restart', description: 'Refused (412) when the kind is not addable, the address is outside 0x08–0x77 or already used, the quantity is already installed, or the probe does not answer.' } })
    .input(Target)
    .output(DeviceResult)
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.hal.addSensor(input.kind, input.addr)
      if (!r.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: r.detail })
      ctx.events.emit({ kind: 'mutation', path: 'devices' })
      return r
    }),
  removeSensor: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/devices/sensors/{kind}/{addr}', tags: ['devices'], summary: 'Remove a probe that was added from the app (sensors from hal.toml are refused)' } })
    .input(Target)
    .output(DeviceResult)
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.hal.removeSensor(input.kind, input.addr)
      if (!r.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: r.detail })
      ctx.events.emit({ kind: 'mutation', path: 'devices' })
      return r
    }),
})
