import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { TANK_ACTION_KINDS, TANK_UNITS } from '../../store/types'
import { publicProcedure, router } from '../trpc'

export const TankActionKind = z.enum(TANK_ACTION_KINDS)
export const TankUnit = z.enum(TANK_UNITS)
const TankActionOut = z.object({
  id: z.number(), ts: z.string(), kind: TankActionKind, amount: z.number().nullable(), unit: TankUnit.nullable(),
  product: z.string().nullable(), note: z.string(), source: z.enum(['user', 'agent']), createdAt: z.string(),
})

/** Logged after the fact is fine; ahead of the unit's clock is a typo. */
const FUTURE_SLACK_MS = 5 * 60_000

export const LogTankAction = z.object({
  kind: TankActionKind,
  /** When it was done; defaults to now. */
  ts: z.string().datetime({ offset: true }).optional(),
  amount: z.number().positive().max(100_000).nullable().optional(),
  unit: TankUnit.nullable().optional(),
  product: z.string().trim().max(80).nullable().optional(),
  note: z.string().max(500).default(''),
  source: z.enum(['user', 'agent']).default('user'),
})

export const tankRouter = router({
  actions: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/tank/actions', tags: ['tank'], summary: 'The tank action log (ADR-0029), newest first: what was fed, topped off, refreshed or pH-adjusted, and when' } })
    .input(z.object({ kind: TankActionKind.optional(), limit: z.number().int().min(1).max(500).default(50) }))
    .output(z.array(TankActionOut))
    .query(({ ctx, input }) => ctx.store.tankActions.list(input)),
  logAction: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/tank/actions', tags: ['tank'], summary: 'Record something done to the tank, such as "fed 1 tsp MaxiGro" or "added 2 mL pH Down"; touches no hardware' } })
    .input(LogTankAction)
    .output(TankActionOut)
    .mutation(({ ctx, input }) => {
      const now = (ctx.now ?? (() => new Date()))()
      const ts = input.ts ? new Date(input.ts) : now
      if ((input.amount == null) !== (input.unit == null)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'an amount needs a unit, and a unit an amount' })
      if (ts.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new TRPCError({ code: 'BAD_REQUEST', message: `${input.ts} is in the future` })
      const row = ctx.store.tankActions.add({
        ts: ts.toISOString(), kind: input.kind, amount: input.amount ?? null, unit: input.unit ?? null,
        product: input.product || null, note: input.note.trim(), source: input.source,
      }, now.toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'tank' })
      return row
    }),
  removeAction: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/tank/actions/{id}', tags: ['tank'] } })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.tankActions.remove(input.id)
      if (removed) ctx.events.emit({ kind: 'mutation', path: 'tank' })
      return { removed }
    }),
})
