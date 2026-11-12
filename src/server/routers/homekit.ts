import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { HomeKitControl } from '../../homekit/types'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Status = z.object({
  /** False where there's no bridge to run (the browser demo, tests). */
  available: z.boolean(),
  enabled: z.boolean(),
  running: z.boolean(),
  transitioning: z.boolean(),
  setupCode: z.string().nullable(),
  setupURI: z.string().nullable(),
  qrSvg: z.string().nullable(),
  pairedControllers: z.number().int().nonnegative(),
  error: z.string().nullable(),
})

const SeedSource = z.enum(['hal-unit-id', 'pi-serial', 'machine-id', 'random'])

const UNAVAILABLE: z.infer<typeof Status> = { available: false, enabled: false, running: false, transitioning: false, setupCode: null, setupURI: null, qrSvg: null, pairedControllers: 0, error: null }

function need(ctx: Context): HomeKitControl {
  if (!ctx.homekit) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'HomeKit isn\'t available on this core' })
  return ctx.homekit
}

async function run(fn: () => Promise<Omit<z.infer<typeof Status>, 'available'>>) {
  try {
    return { available: true, ...await fn() }
  }
  catch (e) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `HomeKit: ${(e as Error).message}`, cause: e })
  }
}

/** HomeKit bridge (ADR 0023). The setup code is readable by any LAN client, like everything else under ADR 0012. */
export const homekitRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/homekit', tags: ['homekit'], summary: 'Whether the HomeKit bridge is on, its setup code and QR, and how many controllers are paired' } })
    .output(Status)
    .query(async ({ ctx }) => (ctx.homekit ? { available: true, ...await ctx.homekit.status() } : UNAVAILABLE)),
  setEnabled: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/homekit/enabled', tags: ['homekit'], summary: 'Turn the HomeKit bridge on or off; it stays off if it fails to start' } })
    .input(z.object({ enabled: z.boolean() }))
    .output(Status)
    .mutation(({ ctx, input }) => {
      const hk = need(ctx)
      return run(() => hk.setEnabled(input.enabled))
    }),
  resetPairing: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/homekit/reset', tags: ['homekit'], summary: 'Remove every HomeKit pairing and issue a new setup code and QR' } })
    .output(Status)
    .mutation(({ ctx }) => {
      const hk = need(ctx)
      return run(() => hk.resetPairing())
    }),
  seedProbe: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/homekit/seed-probe', tags: ['homekit'], summary: 'Which identity seed this unit resolves to (no seed values or codes)' } })
    .output(z.object({
      resolved: SeedSource,
      sources: z.array(z.object({ source: SeedSource, present: z.boolean(), usable: z.boolean() })),
      identity: z.object({ derivedFrom: SeedSource, rotation: z.number().int(), derivedAt: z.number().int() }).nullable(),
    }))
    .query(({ ctx }) => need(ctx).seedProbe()),
  debug: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/homekit/debug', tags: ['homekit'], summary: 'Log hap-nodejs\'s HAP traffic to core\'s journal for up to 60 minutes; 0 stops it. It turns itself off' } })
    .input(z.object({ minutes: z.number().int().min(0).max(60) }))
    .output(z.object({ until: z.string().nullable() }))
    .mutation(({ ctx, input }) => need(ctx).debug(input.minutes)),
})
