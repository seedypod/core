import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

const Status = z.object({
  available: z.boolean(),
  mode: z.enum(['client', 'setup', 'offline']),
  ssid: z.string().nullable(),
  ip: z.string().nullable(),
  setup: z.object({ ssid: z.string(), url: z.string(), until: z.string() }).nullable(),
  lastError: z.string().nullable(),
})

/** Wi-Fi status and the setup flow behind the button's 10-second hold. */
export const networkRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/network/wifi', tags: ['network'], summary: 'Wi-Fi mode (client/setup/offline), network, address, and the setup hotspot if it is up' } })
    .output(Status)
    .query(({ ctx }) => ctx.wifi.status()),
  scan: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/network/wifi/networks', tags: ['network'], summary: 'Networks in range, strongest first' } })
    .output(z.array(z.object({ ssid: z.string(), signal: z.number(), secure: z.boolean(), inUse: z.boolean() })))
    .query(({ ctx }) => ctx.wifi.scan()),
  startSetup: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/network/wifi/setup', tags: ['network'], summary: 'Open the setup hotspot (closes itself after `minutes`)' } })
    .input(z.object({ minutes: z.number().int().min(1).max(60).default(15) }))
    .output(Status)
    .mutation(async ({ ctx, input }) => {
      const s = await ctx.wifi.startSetup(input.minutes)
      ctx.events.emit({ kind: 'mutation', path: 'network' })
      return s
    }),
  stopSetup: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/network/wifi/setup', tags: ['network'], summary: 'Close the setup hotspot and rejoin the saved network' } })
    .output(Status)
    .mutation(async ({ ctx }) => {
      const s = await ctx.wifi.stopSetup()
      ctx.events.emit({ kind: 'mutation', path: 'network' })
      return s
    }),
  connect: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/network/wifi/connect', tags: ['network'], summary: 'Save a network and switch to it a moment after replying' } })
    .input(z.object({ ssid: z.string().min(1).max(64), password: z.string().max(63).optional() }))
    .output(z.object({ ok: z.boolean(), detail: z.string() }))
    .mutation(({ ctx, input }) => ctx.wifi.connect(input.ssid, input.password || undefined)),
})
