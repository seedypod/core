import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { ModelRefused, type ModelRegistry } from '../../vision/registry'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Revision = z.object({
  id: z.string(),
  sha256: z.string().nullable(),
  source: z.enum(['shipped', 'uploaded']),
  analyzer: z.string(),
  version: z.number().nullable(),
  revision: z.string().nullable(),
  bytes: z.number(),
  uploadedAt: z.string().nullable(),
  trainedAt: z.string().nullable(),
  notes: z.string().nullable(),
  enabled: z.boolean(),
  primary: z.boolean(),
  disabled: z.string().optional(),
})
const Selection = z.object({ enabled: z.array(z.string()), primary: z.string().nullable() })
const Event = z.object({
  id: z.number(),
  ts: z.string(),
  action: z.enum(['upload', 'enable', 'disable', 'primary', 'delete', 'reset', 'rollback']),
  revision: z.string().nullable(),
  before: Selection,
  after: Selection,
  rolledBack: z.boolean(),
})

const CODES = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' } as const

/** Run a registry call, turning its refusals into tRPC errors; the browser demo has no registry. */
function registry<T>(ctx: Context, f: (r: ModelRegistry) => T): T {
  if (!ctx.models) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the model registry runs only on a unit' })
  try {
    return f(ctx.models)
  }
  catch (e) {
    if (e instanceof ModelRefused) throw new TRPCError({ code: CODES[e.status], message: e.message })
    throw e
  }
}

/** A change to what runs: the analyser list and the Analysis screen follow. */
function changed(ctx: Context) {
  ctx.events.emit({ kind: 'mutation', path: 'analyses' })
}

export const modelsRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/models', tags: ['models'], summary: 'Pod-state model revisions: the shipped one and every upload, which run, and which is primary' } })
    .output(z.array(Revision))
    .query(({ ctx }) => (ctx.models ? ctx.models.list() : [])),
  events: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/models/events', tags: ['models'], summary: 'Uploads, activations, resets and rollbacks of model revisions, newest first' } })
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .output(z.array(Event))
    .query(({ ctx, input }) => (ctx.models ? ctx.models.events(input?.limit ?? 50) : [])),
  // For MCP and the app; REST clients POST the file to /api/models with the ingest token (server/app.ts).
  upload: publicProcedure
    .input(z.object({ text: z.string().max(2_100_000), sha256: z.string(), enable: z.boolean().optional() }))
    .output(Revision)
    .mutation(({ ctx, input }) => {
      const out = registry(ctx, r => r.upload(input.text, input.sha256, { enable: input.enable }))
      changed(ctx)
      return out
    }),
  set: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/models/{id}', tags: ['models'], summary: 'Enable or disable a revision, or make it primary' } })
    .input(z.object({ id: z.string(), enabled: z.boolean().optional(), primary: z.boolean().optional() }))
    .output(Revision)
    .mutation(({ ctx, input }) => {
      const out = registry(ctx, r => r.set(input.id, { enabled: input.enabled, primary: input.primary }))
      changed(ctx)
      return out
    }),
  remove: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/models/{id}', tags: ['models'], summary: 'Delete an uploaded revision (the shipped one can\'t be deleted)' } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ removed: z.string() }))
    .mutation(({ ctx, input }) => {
      registry(ctx, r => r.remove(input.id))
      changed(ctx)
      return { removed: input.id }
    }),
  reset: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/models/reset', tags: ['models'], summary: 'Run only the shipped model again, as primary; uploads are kept, disabled' } })
    .input(z.object({}).optional())
    .output(Selection)
    .mutation(({ ctx }) => {
      const out = registry(ctx, r => r.reset())
      changed(ctx)
      return out
    }),
  rollback: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/models/rollback', tags: ['models'], summary: 'Undo the newest enable, disable, primary or reset' } })
    .input(z.object({}).optional())
    .output(Event)
    .mutation(({ ctx }) => {
      const out = registry(ctx, r => r.rollback())
      changed(ctx)
      return out
    }),
})
