import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { UPDATE_STATES, type UpdateClient } from '../../update/client'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Channel = z.enum(['stable', 'dev'])

const Status = z.object({
  op: z.string().optional(),
  state: z.enum(UPDATE_STATES),
  at: z.string(),
  channel: Channel.optional(),
  from: z.object({ version: z.string().nullable(), commit: z.string().nullable(), tag: z.string().nullable().optional() }).optional(),
  to: z.object({ tag: z.string(), commit: z.string(), version: z.string().nullable().optional() }).optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  rolledBack: z.boolean().optional(),
})

const Info = z.object({
  available: z.boolean(),
  channel: Channel,
  tag: z.string().nullable(),
  status: Status.nullable(),
  log: z.array(z.string()),
})

const Check = z.object({
  channel: Channel,
  installed: z.object({ version: z.string().nullable(), commit: z.string().nullable(), branch: z.string().nullable(), tag: z.string().nullable() }),
  available: z.object({ tag: z.string(), commit: z.string(), name: z.string(), publishedAt: z.string().nullable(), url: z.string().nullable() }),
  updateAvailable: z.boolean(),
  problem: z.string().nullable(),
})

/** The helper's refusals: one already running is a conflict, a bad argument a bad request, the rest a precondition. */
function refused(e: unknown): never {
  const code = (e as { code?: string }).code
  throw new TRPCError({ code: code === 'busy' ? 'CONFLICT' : code === 'usage' ? 'BAD_REQUEST' : 'PRECONDITION_FAILED', message: (e as Error).message })
}

function updater(ctx: Context): UpdateClient {
  if (!ctx.update) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this core has no updates (demo or tests)' })
  return ctx.update
}

/**
 * Updates from the web (ADR-0026). Core only talks to the root helper; the
 * helper alone goes online, to GitHub's releases, and only for `check` and
 * `start`. Progress arrives as `update` events.
 */
export const updateRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/update', tags: ['update'], summary: 'Whether updates are installed, the channel, and the last or current update with its log' } })
    .output(Info)
    .query(({ ctx }) => ctx.update?.info() ?? { available: false, channel: ctx.version.startsWith('main@') ? 'stable' as const : 'dev' as const, tag: null, status: null, log: [] }),
  check: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/update/check', tags: ['update'], summary: 'Ask GitHub, through the update helper, for the newest release on the channel. Goes online' } })
    .output(Check)
    .mutation(async ({ ctx }) => updater(ctx).check().catch(refused)),
  setChannel: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/update/channel', tags: ['update'], summary: 'Update from stable (the latest vX.Y.Z) or dev (dev-latest)' } })
    .input(z.object({ channel: Channel }))
    .output(z.object({ channel: Channel }))
    .mutation(async ({ ctx, input }) => {
      const channel = await updater(ctx).setChannel(input.channel).catch(refused)
      ctx.events.emit({ kind: 'mutation', path: 'update' })
      return { channel }
    }),
  start: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/update/start', tags: ['update'], summary: 'Download, check and install the newest release on the channel. The unit restarts, and rolls back if it isn\'t healthy' } })
    .output(z.object({ started: z.literal(true), status: Status.nullable() }))
    .mutation(async ({ ctx }) => {
      const status = await updater(ctx).start().catch(refused)
      ctx.events.emit({ kind: 'mutation', path: 'update' })
      return { started: true as const, status }
    }),
})
