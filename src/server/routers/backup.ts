import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

const Record = z.object({ id: z.number(), ts: z.string(), destination: z.enum(['download', 'bucket']), name: z.string(), bytes: z.number(), ok: z.boolean(), detail: z.string() })

const Status = z.object({
  available: z.boolean(),
  lastSuccess: Record.nullable(),
  lastBucketAttempt: Record.nullable(),
  nightly: z.object({ enabled: z.boolean(), hour: z.number(), keep: z.number() }),
  staleAfterDays: z.number(),
  stale: z.boolean(),
  recent: z.array(Record),
})

const BucketBackup = z.object({ key: z.string(), name: z.string(), unit: z.string().nullable(), createdAt: z.string(), size: z.number() })

const BucketConfig = z.object({
  endpoint: z.string().url(),
  bucket: z.string().min(1).max(63),
  region: z.string().min(1).default('auto'),
  prefix: z.string().default(''),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
})

const Summary = z.object({
  createdAt: z.string().nullable(),
  unit: z.object({ id: z.string().nullable(), name: z.string() }).nullable(),
  core: z.string().nullable(),
  schema: z.number().nullable(),
  photos: z.boolean(),
})

const RestoreInfo = z.object({
  available: z.boolean(),
  status: z.object({
    op: z.enum(['restore', 'undo', 'check']),
    state: z.enum(['checking', 'queued', 'stopping', 'restoring', 'starting', 'done', 'failed', 'refused']),
    at: z.string(),
    error: z.string().optional(),
    code: z.string().optional(),
    bundle: Summary.optional(),
    undone: z.boolean().optional(),
  }).nullable(),
  undo: z.object({ restoredAt: z.string(), bundle: Summary, undoneAt: z.string().nullable() }).nullable(),
})

function precondition(e: unknown): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (e as Error).message })
}

/** The helper's refusals: a newer schema is a conflict, a damaged or foreign file a bad request. */
function refused(e: unknown): never {
  const code = (e as { code?: string }).code
  throw new TRPCError({ code: code === 'newer-schema' ? 'CONFLICT' : code === 'invalid' ? 'BAD_REQUEST' : 'PRECONDITION_FAILED', message: (e as Error).message })
}

/** Off-card backups (ADR-0021). The bundle itself downloads from `GET /api/backup/download`. */
export const backupRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/backup', tags: ['backup'], summary: 'Last off-card backup, nightly bucket uploads, and whether backup_stale is raised' } })
    .output(Status)
    .query(({ ctx }) => ctx.backup
      ? { available: true, ...ctx.backup.status() }
      : { available: false, lastSuccess: null, lastBucketAttempt: null, nightly: { enabled: false, hour: 3, keep: 14 }, staleAfterDays: 7, stale: false, recent: [] }),
  runNow: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/backup/run', tags: ['backup'], summary: 'Back up to the mirror\'s bucket now (the nightly upload, early)' } })
    .output(Record)
    .mutation(async ({ ctx }) => {
      if (!ctx.backup) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this core has no backups (demo or tests)' })
      return ctx.backup.backupToBucket().catch(precondition)
    }),
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/backup/bucket', tags: ['backup'], summary: 'Backups in the mirror\'s bucket (backups/), newest first' } })
    .output(z.array(BucketBackup))
    .query(async ({ ctx }) => {
      if (!ctx.backup) return []
      return ctx.backup.list().catch(precondition)
    }),
  browse: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/backup/browse', tags: ['backup'], summary: 'List the backups in a bucket that isn\'t saved yet (Welcome → Restore); the saved mirror when config is omitted' } })
    .input(z.object({ config: BucketConfig.optional() }))
    .output(z.array(BucketBackup))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.backup) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this core has no backups (demo or tests)' })
      return ctx.backup.list(input.config).catch(precondition)
    }),
  restoreInfo: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/backup/restore', tags: ['backup'], summary: 'Whether restore is installed, the last restore or undo, and what an undo would put back' } })
    .output(RestoreInfo)
    .query(({ ctx }) => ctx.restore?.info() ?? { available: false, status: null, undo: null }),
  restoreFromBucket: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/backup/restore-from-bucket', tags: ['backup'], summary: 'Restore a backup from the bucket. The bundle is checked first; then the unit restarts on it (upload a file with POST /api/backup/restore)' } })
    .input(z.object({ key: z.string().min(1), config: BucketConfig.optional() }))
    .output(z.object({ restarting: z.literal(true), bundle: Summary.nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.backup || !ctx.restore) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this core has no restore (demo or tests)' })
      const bytes = await ctx.backup.fetch(input.key, input.config).catch(precondition)
      const bundle = await ctx.restore.restore(bytes).catch(refused)
      return { restarting: true as const, bundle }
    }),
  undo: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/backup/undo', tags: ['backup'], summary: 'Put back what the last restore replaced; again to redo it. The unit restarts' } })
    .output(z.object({ restarting: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      if (!ctx.restore) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this core has no restore (demo or tests)' })
      await ctx.restore.undo().catch(refused)
      return { restarting: true as const }
    }),
})
