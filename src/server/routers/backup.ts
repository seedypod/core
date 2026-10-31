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

function precondition(e: unknown): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (e as Error).message })
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
})
