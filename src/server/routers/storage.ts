import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Status = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  pending: z.number(),
  uploaded: z.number(),
  failed: z.number(),
  lastError: z.string().nullable(),
  lastUploadAt: z.string().nullable(),
})

const Flash = z.object({
  available: z.boolean(),
  device: z.string().nullable(),
  cardBytes: z.number().nullable(),
  sinceBootBytes: z.number().nullable(),
  uptimeS: z.number().nullable(),
  bytesPerDay: z.number().nullable(),
  basis: z.enum(['history', 'boot']).nullable(),
  windowDays: z.number().nullable(),
  lastSampleAt: z.string().nullable(),
  usedBytes: z.number().nullable(),
  freeBytes: z.number().nullable(),
})

const Integrity = z.object({ ok: z.boolean(), detail: z.string(), checkedAt: z.string(), ms: z.number() })

const Database = z.object({
  at: z.string(),
  scanMs: z.number(),
  path: z.string(),
  fileBytes: z.number(),
  walBytes: z.number(),
  journalMode: z.string(),
  pageSize: z.number(),
  freePages: z.number(),
  migrations: z.object({ applied: z.number(), known: z.number(), latestTag: z.string().nullable(), appliedTag: z.string().nullable() }),
  tables: z.array(z.object({
    name: z.string(),
    rows: z.number(),
    bytes: z.number().nullable(),
    timeColumn: z.string().nullable(),
    basis: z.enum(['inserted', 'changed']).nullable(),
    lastWriteAt: z.string().nullable(),
    hourly: z.array(z.number()).nullable(),
    writes24h: z.number().nullable(),
  })),
  integrity: Integrity.nullable(),
})

function inspector(ctx: Context) {
  if (!ctx.database) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this core has no database inspector (tests)' })
  return ctx.database
}

/** The SD card's write meter and the database view behind it (ADR-0021), and the opt-in off-device mirror (ADR-0019), configured in settings and driven from here. */
export const storageRouter = router({
  flash: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/storage/flash', tags: ['storage'], summary: 'SD card writes: bytes per day (7-day average, or since boot until a day of samples exists), written since boot, card size, and used/free space where the data lives' } })
    .output(Flash)
    .query(({ ctx }) => ctx.flash.status()),
  database: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/storage/database', tags: ['storage'], summary: 'Metadata about seedypod.db, never row contents: file and WAL size, journal mode, migrations, and rows, bytes, last write and rows per hour over 24 h for each table. Cached for at least 5 minutes' } })
    .output(Database)
    .query(({ ctx }) => inspector(ctx).inspect()),
  checkDatabase: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/storage/database/integrity', tags: ['storage'], summary: 'Run SQLite quick_check on a read-only connection; reads the whole file, so it can take minutes on a unit' } })
    .output(Integrity)
    .mutation(({ ctx }) => inspector(ctx).checkIntegrity()),
  mirror: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/storage/mirror', tags: ['storage'], summary: 'Off-device mirror status: enabled, uploads pending/done/failed, last error' } })
    .output(Status)
    .query(({ ctx }) => ctx.mirror
      ? { available: true, ...ctx.mirror.status() }
      : { available: false, enabled: false, pending: 0, uploaded: 0, failed: 0, lastError: null, lastUploadAt: null }),
  testMirror: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/storage/mirror/test', tags: ['storage'], summary: 'Write, read back and delete a probe object with the saved mirror settings' } })
    .output(z.object({ ok: z.boolean(), detail: z.string() }))
    .mutation(async ({ ctx }) => ctx.mirror ? ctx.mirror.test() : { ok: false, detail: 'this core has no mirror (demo or tests)' }),
  syncMirror: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/storage/mirror/sync', tags: ['storage'], summary: 'Copy the stills and artifacts already on the unit to the mirror' } })
    .output(z.object({ queued: z.number() }))
    .mutation(async ({ ctx }) => {
      if (!ctx.mirror) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this core has no mirror (demo or tests)' })
      const captures = ctx.store.captures.list(undefined, Number.MAX_SAFE_INTEGER)
      const artifacts = captures.flatMap(c => ctx.store.analyses.forCapture(c.id).map(r => r.artifact)).filter((a): a is string => !!a)
      try {
        return { queued: await ctx.mirror.sync([...captures.map(c => c.path).filter(p => !p.startsWith('data:')), ...new Set(artifacts)]) }
      }
      catch (e) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (e as Error).message })
      }
    }),
})
