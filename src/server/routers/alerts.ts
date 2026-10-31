import { Alert, AlertKind } from '../../hardware/contract'
import { publicProcedure, router } from '../trpc'
import { z } from 'zod'

export const alertsRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/alerts', tags: ['alerts'] } })
    .output(z.array(Alert))
    .query(({ ctx }) => Object.values(ctx.hal.snapshot().alerts) as z.infer<typeof Alert>[]),
  acknowledge: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/alerts/{kind}/acknowledge', tags: ['alerts'], summary: 'Clear a latched fault so the actuator may be re-enabled' } })
    .input(z.object({ kind: AlertKind }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.hal.acknowledgeAlert(input.kind)
      ctx.events.emit({ kind: 'mutation', path: `alerts.${input.kind}` })
      return { ok: true as const }
    }),
})
