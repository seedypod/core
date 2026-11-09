import { z } from 'zod'
import { choreDoneKind } from '../../care/engine'
import { AlertKind } from '../../hardware/contract'
import { publicProcedure, router } from '../trpc'

const AlertOut = z.object({
  id: z.number(), kind: z.string(), active: z.boolean(), detail: z.string(), raisedAt: z.string(),
  clearedAt: z.string().nullable(), acknowledgedAt: z.string().nullable(), dismissedAt: z.string().nullable(),
})

export const alertsRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/alerts', tags: ['alerts'] } })
    .input(z.object({ activeOnly: z.boolean().default(true) }))
    .output(z.array(AlertOut))
    .query(({ ctx, input }) => ctx.store.alerts.list({ activeOnly: input.activeOnly })),
  /** Acknowledge: for HAL latched faults this also clears the latch in the daemon; for reminders it marks the chore done, and for a chore alert logs it in the tank log. */
  acknowledge: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/alerts/{id}/acknowledge', tags: ['alerts'], summary: 'Acknowledge an alert; clears a latched hardware fault so the actuator may re-enable' } })
    .input(z.object({ id: z.number().int() }))
    .output(AlertOut.nullable())
    .mutation(async ({ ctx, input }) => {
      const now = (ctx.now ?? (() => new Date()))().toISOString()
      const row = ctx.store.alerts.acknowledge(input.id, now)
      if (!row) return null
      const halKind = AlertKind.safeParse(row.kind)
      if (halKind.success) await ctx.hal.acknowledgeAlert(halKind.data)
      const wasActive = row.active
      const cleared = ctx.store.alerts.clear(row.kind, now) ?? row
      // A chore's alert is done by doing the chore: log it, so the chore counts from now (ADR-0029).
      const done = choreDoneKind(row.kind)
      if (done && wasActive) {
        ctx.store.tankActions.add({ ts: now, kind: done, amount: null, unit: null, product: null, note: 'Marked done in Alerts', source: 'user' }, now)
        ctx.events.emit({ kind: 'mutation', path: 'tank' })
      }
      ctx.events.emit({ kind: 'mutation', path: `alerts.${row.kind}` })
      return cleared
    }),
  dismiss: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/alerts/{id}/dismiss', tags: ['alerts'] } })
    .input(z.object({ id: z.number().int() }))
    .output(AlertOut.nullable())
    .mutation(({ ctx, input }) => {
      const row = ctx.store.alerts.dismiss(input.id, (ctx.now ?? (() => new Date()))().toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'alerts' })
      return row
    }),
})
