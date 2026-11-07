import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

const Profile = z.object({
  key: z.string(),
  name: z.string(),
  harvestMinDays: z.number().nullable(),
  harvestMaxDays: z.number().nullable(),
  targetCover: z.number().nullable(),
  notes: z.string(),
  source: z.enum(['user', 'agent']),
  updatedAt: z.string(),
})

/** One profile as written: the window in whole days from planting, the target as leaf cover 0–1. */
export const ProfileIn = z.object({
  name: z.string().trim().min(1).max(80),
  harvestMinDays: z.number().int().min(1).max(365).nullable().default(null),
  harvestMaxDays: z.number().int().min(1).max(365).nullable().default(null),
  targetCover: z.number().min(0.05).max(1).nullable().default(null),
  notes: z.string().max(500).default(''),
  source: z.enum(['user', 'agent']).default('user'),
}).refine(p => p.harvestMinDays === null || p.harvestMaxDays === null || p.harvestMinDays <= p.harvestMaxDays, { message: 'harvestMinDays must not exceed harvestMaxDays' })

/** Optional per-crop harvest knowledge (ADR-0022): windows and leaf-cover targets that sharpen the camera's outlook. */
export const plantsRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/plants', tags: ['grow'], summary: 'Plant profiles: harvest window and leaf-cover target per crop' } })
    .output(z.array(Profile))
    .query(({ ctx }) => ctx.store.plants.list()),
  upsert: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/plants', tags: ['grow'], summary: 'Create or replace plant profiles by name' } })
    .input(z.object({ profiles: z.array(ProfileIn).min(1).max(100) }))
    .output(z.array(Profile))
    .mutation(({ ctx, input }) => {
      const ts = (ctx.now ?? (() => new Date()))().toISOString()
      const out = input.profiles.map(p => ctx.store.plants.upsert(p, ts))
      ctx.events.emit({ kind: 'mutation', path: 'plants' })
      return out
    }),
  remove: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/plants/{name}', tags: ['grow'] } })
    .input(z.object({ name: z.string().min(1) }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.plants.remove(input.name)
      if (removed) ctx.events.emit({ kind: 'mutation', path: 'plants' })
      return { removed }
    }),
})
