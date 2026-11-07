import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { SystemInfo } from '../../hardware/contract'
import { bridgeStatus } from '../../mqtt/bridge'
import { Check, systemChecks } from '../checks'
import { publicProcedure, router } from '../trpc'
import { summariseBootLog } from '../bootLog'

/** Matches src/logging/policy.ts, which the browser demo can't import. */
const MAX_DEBUG_MINUTES = 240
const LoggingMode = z.enum(['quiet', 'off'])
const LoggingState = z.object({ mode: z.enum(['quiet', 'off', 'debug']), loggingMode: LoggingMode, debugUntil: z.string().nullable() })

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
  bootLog: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/boot-log/summary', tags: ['system'], summary: 'Boots on record, and how often the USB hub came up by itself lately' } })
    .output(z.object({ boots: z.number(), hub: z.object({ up: z.number(), of: z.number() }).nullable() }).nullable())
    .query(async ({ ctx }) => {
      const text = await ctx.bootLog?.()
      return text ? summariseBootLog(text) : null
    }),
  bridge: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/bridge', tags: ['system'], summary: 'Home Assistant MQTT bridge: off, connected or disconnected, the broker, and the last connect error' } })
    .output(z.object({ state: z.enum(['off', 'connected', 'disconnected']), broker: z.string().nullable(), since: z.string().nullable(), error: z.string().nullable() }))
    .query(({ ctx }) => ctx.bridge?.() ?? bridgeStatus(ctx.store.settings.get().mqttUrl, null, null)),
  logging: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/logging', tags: ['system'], summary: 'How much core and hald log: quiet (warnings and errors), off, or debug until a time' } })
    .output(LoggingState.nullable())
    .query(({ ctx }) => ctx.logging?.get() ?? null),
  setLogging: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/system/logging', tags: ['system'], summary: 'Set quiet or off, and open a debug window of up to 4 hours that ends by itself (0 closes it)' } })
    .input(z.object({ mode: LoggingMode.optional(), debugMinutes: z.number().int().min(0).max(MAX_DEBUG_MINUTES).optional() }))
    .output(LoggingState)
    .mutation(({ ctx, input }) => {
      if (!ctx.logging) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'logging isn\'t adjustable on this core' })
      return ctx.logging.set(input)
    }),
  healthcheck: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/healthcheck', tags: ['system'] } })
    .output(z.object({ ok: z.literal(true), ts: z.string() }))
    .query(() => ({ ok: true as const, ts: new Date().toISOString() })),
})
