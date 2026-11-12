import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { activateEntry, activeEntryId, libraryEntries, libraryEntry } from '../../care/library'
import { autoLight, setAuto } from '../../care/lightAuto'
import { readTower } from '../../care/tower'
import { plantSlug } from '../../plants/custom'
import { LIGHT_PRESETS } from '../../scheduler/lightPlan'
import { curveTarget, lightLevelAt } from '../../scheduler/scheduler'
import { dayEnabled, localTime } from '../../scheduler/time'
import { followSun } from '../../scheduler/sun'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const SunFollow = z.object({ minHours: z.number().min(1).max(20), maxHours: z.number().min(1).max(20), rampMin: z.number().int().min(0).max(240), shiftMin: z.number().int().min(-360).max(360), auto: z.boolean().optional() })
  .refine(s => s.minHours <= s.maxHours, { message: 'minHours is more than maxHours' })
const LightSpec = z.object({ setpoints: z.array(z.object({ minute: z.number().int().min(0).max(1439), level: z.number().min(0).max(100) })).max(24), sun: SunFollow.optional() })
const PumpSpec = z.object({ minute: z.number().int().min(0).max(1439), durationS: z.number().int().positive().max(3600), level: z.number().min(1).max(100).optional() })

/** trpc-to-openapi needs a ZodObject input, so the kind/spec pairing is checked in a refinement. */
export const ScheduleSchema = z.object({
  id: z.string().min(1), kind: z.enum(['light', 'pump']), name: z.string().min(1), enabled: z.boolean(), days: z.number().int().min(0).max(127),
  spec: z.union([LightSpec, PumpSpec]),
}).refine(s => (s.kind === 'light' ? 'setpoints' in s.spec : 'durationS' in s.spec), { message: 'spec does not match kind', path: ['spec'] })

const ScheduleOut = z.object({
  id: z.string(), kind: z.enum(['light', 'pump']), name: z.string(), enabled: z.boolean(), days: z.number(),
  spec: z.union([LightSpec, PumpSpec]), createdAt: z.string(), updatedAt: z.string(),
})

const SavedCycle = z.object({ minute: z.number().int().min(0).max(1439), durationS: z.number().int().positive().max(3600), days: z.number().int().min(1).max(127) })
// Activating writes one pump schedule per run time, so two runs can't share a minute.
const SavedCycles = z.array(SavedCycle).min(1).max(12).refine(cs => new Set(cs.map(c => c.minute)).size === cs.length, { message: 'two cycles start at the same minute' })
const LightPresetId = z.string().refine(id => LIGHT_PRESETS.some(p => p.id === id), { message: 'not a light preset' }).nullable()
const Entry = z.object({
  id: z.string(), name: z.string(), kind: z.enum(['own', 'preset']), cycles: z.array(SavedCycle), lightPresetId: z.string().nullable(),
  lastUsedAt: z.string().nullable(), active: z.boolean(), readOnly: z.boolean(),
})

const now = (ctx: Context) => (ctx.now ?? (() => new Date()))()
const entries = (ctx: Context) => {
  const t = readTower(ctx.store)
  const active = activeEntryId(t)
  return libraryEntries(t, now(ctx)).map(e => ({ ...e, active: e.id === active, readOnly: e.kind === 'preset' }))
}
const own = (ctx: Context, id: string) => {
  if (id.startsWith('preset:')) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Built-in presets are read-only: duplicate one to change it' })
  const s = ctx.store.scheduleLibrary.get(id)
  if (!s) throw new TRPCError({ code: 'NOT_FOUND', message: `no schedule ${id}` })
  return s
}
const changed = (ctx: Context, id: string) => {
  ctx.events.emit({ kind: 'mutation', path: 'schedules.library' })
  ctx.events.emit({ kind: 'schedule', action: 'changed', id: `library:${id}` })
}

/** Your schedules (ADR-0030): saved sets of pump cycles beside the read-only presets; exactly the active one is on the pump. */
const libraryRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedules/library', tags: ['schedules'], summary: 'Your schedules, then the built-in water presets (read-only), with which one the pump cycles are now' } })
    .output(z.array(Entry))
    .query(({ ctx }) => entries(ctx)),
  create: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedules/library', tags: ['schedules'], summary: 'Save a new schedule; activate it to use it' } })
    .input(z.object({ name: z.string().trim().min(1).max(60), cycles: SavedCycles, lightPresetId: LightPresetId.default(null) }))
    .output(Entry)
    .mutation(({ ctx, input }) => {
      const base = plantSlug(input.name) || 'schedule'
      let id = base
      for (let n = 2; ctx.store.scheduleLibrary.get(id); n++) id = `${base}-${n}`
      ctx.store.scheduleLibrary.upsert({ id, ...input }, now(ctx).toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'schedules.library' })
      return entries(ctx).find(e => e.id === id) as z.infer<typeof Entry>
    }),
  update: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/schedules/library/{id}', tags: ['schedules'], summary: 'Change a saved schedule; if it is the active one, the pump cycles change with it' } })
    .input(z.object({ id: z.string(), name: z.string().trim().min(1).max(60).optional(), cycles: SavedCycles.optional(), lightPresetId: LightPresetId.optional() }))
    .output(Entry)
    .mutation(({ ctx, input }) => {
      const prev = own(ctx, input.id)
      const wasActive = activeEntryId(readTower(ctx.store)) === prev.id
      const { id, ...patch } = input
      const next = ctx.store.scheduleLibrary.upsert({ id, name: patch.name ?? prev.name, cycles: patch.cycles ?? prev.cycles, lightPresetId: patch.lightPresetId === undefined ? prev.lightPresetId : patch.lightPresetId }, now(ctx).toISOString())
      if (wasActive) {
        const entry = libraryEntry(readTower(ctx.store), next.id, now(ctx))
        if (entry) activateEntry(ctx.store, entry, now(ctx))
        changed(ctx, id)
      }
      else ctx.events.emit({ kind: 'mutation', path: 'schedules.library' })
      return entries(ctx).find(e => e.id === id) as z.infer<typeof Entry>
    }),
  delete: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/schedules/library/{id}', tags: ['schedules'], summary: 'Delete a saved schedule; its pump cycles stay on until another is used. A Then that named it goes back to staying in maintenance' } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      own(ctx, input.id)
      const removed = ctx.store.scheduleLibrary.remove(input.id)
      const cycle = ctx.store.grow.current()
      if (cycle?.thenKind === 'schedule' && cycle.thenScheduleId === input.id) {
        ctx.store.grow.setProtocol({ thenKind: 'stay', thenScheduleId: null })
        ctx.events.emit({ kind: 'mutation', path: 'grow' })
      }
      ctx.events.emit({ kind: 'mutation', path: 'schedules.library' })
      return { removed }
    }),
  activate: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedules/library/{id}/activate', tags: ['schedules'], summary: 'Use a schedule now: its cycles replace the pump cycles (and its light preset the light). Using one of yours takes watering off the grow protocol; using the current stage\'s preset hands it back' } })
    .input(z.object({ id: z.string() }))
    .output(z.array(Entry))
    .mutation(({ ctx, input }) => {
      const entry = libraryEntry(readTower(ctx.store), input.id, now(ctx))
      if (!entry) throw new TRPCError({ code: 'NOT_FOUND', message: `no schedule ${input.id}` })
      activateEntry(ctx.store, entry, now(ctx))
      changed(ctx, input.id)
      return entries(ctx)
    }),
})

export const schedulesRouter = router({
  library: libraryRouter,
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedules', tags: ['schedules'] } })
    .output(z.array(ScheduleOut))
    .query(({ ctx }) => ctx.store.schedules.list()),
  upsert: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/schedules/{id}', tags: ['schedules'], summary: 'Create or replace a light curve or pump cycle' } })
    .input(ScheduleSchema)
    .output(ScheduleOut)
    .mutation(({ ctx, input }) => {
      // A sun-following curve gets today's setpoints now, not at the next tick.
      const settings = ctx.store.settings.get()
      const spec = 'setpoints' in input.spec ? followSun(input.spec, settings, now(ctx), autoLight(ctx.store)) : input.spec
      const row = ctx.store.schedules.upsert({ ...input, spec } as Parameters<typeof ctx.store.schedules.upsert>[0])
      ctx.events.emit({ kind: 'schedule', action: 'changed', id: input.id })
      return row
    }),
  remove: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/schedules/{id}', tags: ['schedules'] } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.schedules.remove(input.id)
      ctx.events.emit({ kind: 'schedule', action: 'changed', id: input.id })
      return { removed }
    }),
  /** Auto curves' hours of full light now, and the grow protocol they come from. */
  autoLight: publicProcedure
    .output(z.object({ protocolId: z.string(), protocolName: z.string(), minHours: z.number(), maxHours: z.number(), why: z.string() }))
    .query(({ ctx }) => autoLight(ctx.store)),
  /** Auto on runs its curve alone and keeps the others to turn back on; off brings them back. */
  setAuto: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedules/auto', tags: ['schedules'], summary: 'Turn Auto light on or off' } })
    .input(z.object({ on: z.boolean() }))
    .output(z.object({ on: z.boolean(), changed: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const at = now(ctx)
      const changed = setAuto(ctx.store, input.on, at)
      for (const id of changed) ctx.events.emit({ kind: 'schedule', action: 'changed', id })
      // Switching Auto hands the light back from a hand's hold, and the curves take it now rather than at the next minute's tick.
      const lt = localTime(at, ctx.store.settings.get().timezone)
      await ctx.light.setSchedule(curveTarget(ctx.store.schedules.list().filter(s => s.enabled && dayEnabled(s.days, lt.weekday)), lt.minute))
      await ctx.light.resume()
      await ctx.light.idle()
      ctx.events.emit({ kind: 'mutation', path: 'actuators.light' })
      return { on: input.on, changed }
    }),
  /** Preview a light curve as 96 samples (every 15 min) for charts. */
  previewCurve: publicProcedure
    .input(LightSpec)
    .output(z.array(z.object({ minute: z.number(), level: z.number().nullable() })))
    .query(({ input }) => Array.from({ length: 96 }, (_, i) => ({ minute: i * 15, level: lightLevelAt(input, i * 15) }))),
  recentRuns: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedules/runs', tags: ['schedules'] } })
    .output(z.array(z.object({ scheduleId: z.string(), key: z.string(), firedAt: z.string(), result: z.string() })))
    .query(({ ctx }) => ctx.store.schedules.recentRuns()),
})
