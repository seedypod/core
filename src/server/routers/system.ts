import { arch, hostname } from 'node:os'
import { z } from 'zod'
import { SystemInfo } from '../../hardware/contract'
import { publicProcedure, router } from '../trpc'

export const systemRouter = router({
  info: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system', tags: ['system'], summary: 'Identity, HAL model, limits and core version' } })
    .output(z.object({ coreVersion: z.string(), coreHost: z.object({ hostname: z.string(), arch: z.string() }), halOnline: z.boolean(), system: SystemInfo.nullable() }))
    .query(({ ctx }) => {
      const snap = ctx.hal.snapshot()
      return {
        coreVersion: ctx.version,
        // Where core runs: on the unit's Pi Zero 2 W, or on another machine when the unit has a Pi Zero W.
        coreHost: { hostname: hostname(), arch: arch() },
        halOnline: snap.online,
        system: snap.system,
      }
    }),
  healthcheck: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/healthcheck', tags: ['system'] } })
    .output(z.object({ ok: z.literal(true), ts: z.string() }))
    .query(() => ({ ok: true as const, ts: new Date().toISOString() })),
})
