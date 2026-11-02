import { z } from 'zod'
import { SystemInfo } from '../../hardware/contract'
import { bridgeStatus } from '../../mqtt/bridge'
import { Check, systemChecks } from '../checks'
import { publicProcedure, router } from '../trpc'

export const systemRouter = router({
  info: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system', tags: ['system'], summary: 'Identity, HAL model, limits and core version' } })
    .output(z.object({ coreVersion: z.string(), coreHost: z.object({ hostname: z.string(), arch: z.string() }).nullable(), halOnline: z.boolean(), system: SystemInfo.nullable() }))
    .query(({ ctx }) => {
      const snap = ctx.hal.snapshot()
      return {
        coreVersion: ctx.version,
        // Where core runs: on the unit's Pi Zero 2 W, or on another machine when the unit has a Pi Zero W.
        coreHost: ctx.host ?? null,
        halOnline: snap.online,
        system: snap.system,
      }
    }),
  checks: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/checks', tags: ['system'], summary: 'One line per part of the unit (daemon, sensors, outputs, cameras, services): ok, idle, stalled or down' } })
    .output(z.object({ checks: z.array(Check) }))
    .query(async ({ ctx }) => ({ checks: await systemChecks(ctx) })),
  bridge: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/bridge', tags: ['system'], summary: 'Home Assistant MQTT bridge: off, connected or disconnected, the broker, and the last connect error' } })
    .output(z.object({ state: z.enum(['off', 'connected', 'disconnected']), broker: z.string().nullable(), since: z.string().nullable(), error: z.string().nullable() }))
    .query(({ ctx }) => ctx.bridge?.() ?? bridgeStatus(ctx.store.settings.get().mqttUrl, null, null)),
  healthcheck: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/healthcheck', tags: ['system'] } })
    .output(z.object({ ok: z.literal(true), ts: z.string() }))
    .query(() => ({ ok: true as const, ts: new Date().toISOString() })),
})
