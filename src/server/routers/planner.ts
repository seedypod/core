import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { Category, CATALOG_SOURCES, findPlant, getPlant, Plant, searchPlants, Zone } from '../../plants/catalog'
import { bestSpots, planLayout, sowingPlan } from '../../plants/planner'
import { MODELS, slots, zoneCounts } from '../../plants/zones'
import { publicProcedure, router } from '../trpc'

const Model = z.enum(['home', 'studio', 'nursery'])
const Request = z.array(z.object({ plantId: z.string(), count: z.number().int().min(1).max(30) })).max(60)
const Assignment = z.object({ slot: z.number(), row: z.number(), col: z.number(), slotZone: Zone.nullable(), plantId: z.string(), plantName: z.string(), wantZone: Zone, fallback: z.number(), reason: z.string() })
/** Caller overrides: pin pods to slots, or let a plant use other zones than its ideal-or-one-lower. */
export const Overrides = z.object({
  pins: z.array(z.object({ slot: z.number().int().min(1).max(60), plantId: z.string() })).max(60).optional(),
  allowedZones: z.record(z.string(), z.array(Zone).min(1).max(3)).optional(),
})
const ZoneSummary = z.object({ zone: Zone, rows: z.array(z.number()), slots: z.array(z.number()), total: z.number(), existing: z.number(), planned: z.number(), free: z.number() })
const Blocker = z.object({ slot: z.number(), zone: Zone, plantId: z.string(), plantName: z.string(), existing: z.boolean() })
const Unplaced = z.object({ plantId: z.string(), plantName: z.string(), reason: z.string(), code: z.enum(['not_in_catalog', 'no_space', 'bad_pin']), wantZone: Zone.nullable(), zones: z.array(Zone), blocking: z.array(Blocker) })
const Suggestion = z.object({
  plantId: z.string(), plantName: z.string(), kind: z.enum(['relocate', 'allow_lower']), slot: z.number(), zone: Zone,
  move: z.object({ plantId: z.string(), plantName: z.string(), from: z.number(), to: z.number(), toZone: Zone, existing: z.boolean() }).nullable(),
  text: z.string(), overrides: Overrides.nullable(),
})
const Layout = z.object({ model: Model, assignments: z.array(Assignment), unplaced: z.array(Unplaced), free: z.array(z.number()), zones: z.array(ZoneSummary), suggestions: z.array(Suggestion), overrides: Overrides.optional() })
/** Plans saved before the zone summary and structured reasons existed lack them. */
const SavedLayout = Layout.extend({ unplaced: z.array(Unplaced.partial({ code: true, wantZone: true, zones: true, blocking: true })), zones: z.array(ZoneSummary).optional(), suggestions: z.array(Suggestion).optional() })
const Wave = z.object({ plantId: z.string(), plantName: z.string(), wave: z.number(), sowOn: z.string(), firstHarvestFrom: z.string(), firstHarvestTo: z.string(), harvestEstimated: z.boolean() })
const PlanOut = z.object({
  id: z.string(), name: z.string(), model: Model, mode: z.enum(['staggered', 'batch']), request: Request, layout: SavedLayout, sowing: z.array(Wave),
  createdAt: z.string(), updatedAt: z.string(), appliedAt: z.string().nullable(), issued: z.array(z.string()),
})

/** Pods currently planted, as slot → catalog plant id (unknown names are kept as occupied). */
function occupiedFromPods(pods: { slot: number, plant: string | null, status: string }[]): Record<number, string> {
  const out: Record<number, string> = {}
  for (const p of pods) {
    if (p.status === 'empty' || !p.plant) continue
    const id = findPlant(p.plant)?.id
    out[p.slot] = id ?? `unknown:${p.plant}`
  }
  return out
}

/**
 * For each plant, its pods (by slot order) take its sowing waves in order:
 * the first pod is wave 1 and is sown now, later pods wait for their date.
 */
function podSchedule(layout: z.infer<typeof SavedLayout>, sowing: z.infer<typeof Wave>[]) {
  const waves = new Map<string, z.infer<typeof Wave>[]>()
  for (const w of sowing) waves.set(w.plantId, [...(waves.get(w.plantId) ?? []), w])
  const used = new Map<string, number>()
  return layout.assignments.map((a) => {
    const i = used.get(a.plantId) ?? 0
    used.set(a.plantId, i + 1)
    return { ...a, wave: waves.get(a.plantId)?.[i] ?? null }
  })
}

export const plannerRouter = router({
  catalog: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/planner/catalog', tags: ['planner'], summary: 'Plant catalog (Gardyn light zones, harvest windows, care levels)' } })
    .input(z.object({ q: z.string().optional(), category: Category.optional(), zone: Zone.optional(), inStore: z.boolean().optional() }))
    .output(z.object({ plants: z.array(Plant), sources: z.record(z.string(), z.string()) }))
    .query(({ input }) => ({ plants: searchPlants(input), sources: CATALOG_SOURCES })),

  zones: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/planner/zones/{model}', tags: ['planner'], summary: 'Light-zone map for a Gardyn model' } })
    .input(z.object({ model: Model }))
    .output(z.object({ model: Model, name: z.string(), cols: z.number(), rows: z.number(), slots: z.array(z.object({ slot: z.number(), row: z.number(), col: z.number(), zone: Zone.nullable() })), counts: z.object({ high: z.number(), medium: z.number(), low: z.number() }) }))
    .query(({ input }) => {
      const m = MODELS[input.model]
      return { model: m.model, name: m.name, cols: m.cols, rows: m.rows, slots: slots(input.model), counts: zoneCounts(input.model) }
    }),

  layout: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/planner/layout', tags: ['planner'], summary: 'Auto-place plants by light zone (Gardyn rules), with a zone summary, structured unplaced reasons and suggested moves' } })
    .input(z.object({ model: Model, plants: Request, respectExisting: z.boolean().default(true), overrides: Overrides.optional() }))
    .output(Layout)
    .query(({ ctx, input }) => planLayout({ model: input.model, plants: input.plants, occupied: input.respectExisting ? occupiedFromPods(ctx.store.pods.list()) : {}, overrides: input.overrides })),

  bestSpots: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/planner/best-spots', tags: ['planner'], summary: 'Best free slots for one more plant' } })
    .input(z.object({ model: Model, plantId: z.string(), limit: z.number().int().min(1).max(30).default(5) }))
    .output(z.array(z.object({ slot: z.number(), zone: Zone.nullable(), fallback: z.number(), reason: z.string() })))
    .query(({ ctx, input }) => bestSpots(input.model, input.plantId, occupiedFromPods(ctx.store.pods.list()), input.limit)),

  sowing: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/planner/sowing', tags: ['planner'], summary: 'Staggered sowing dates from Gardyn succession guidance' } })
    .input(z.object({ plants: Request, start: z.string().optional(), mode: z.enum(['staggered', 'batch']).default('staggered') }))
    .output(z.array(Wave))
    .query(({ ctx, input }) => sowingPlan(input.plants, input.start ? new Date(input.start) : (ctx.now ?? (() => new Date()))(), input.mode)),

  plans: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/plans', tags: ['planner'] } })
    .output(z.array(PlanOut))
    .query(({ ctx }) => ctx.store.plans.list()),

  savePlan: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/plans/{id}', tags: ['planner'], summary: 'Compute and save a layout + sowing plan' } })
    .input(z.object({ id: z.string().min(1), name: z.string().min(1).max(60), model: Model, mode: z.enum(['staggered', 'batch']).default('staggered'), plants: Request, start: z.string().optional(), overrides: Overrides.optional() }))
    .output(PlanOut)
    .mutation(({ ctx, input }) => {
      const layout = planLayout({ model: input.model, plants: input.plants, occupied: occupiedFromPods(ctx.store.pods.list()), overrides: input.overrides })
      const sowing = sowingPlan(input.plants, input.start ? new Date(input.start) : (ctx.now ?? (() => new Date()))(), input.mode)
      const row = ctx.store.plans.save({ id: input.id, name: input.name, model: input.model, mode: input.mode, request: input.plants, layout, sowing })
      ctx.events.emit({ kind: 'mutation', path: 'plans' })
      return row
    }),

  removePlan: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/plans/{id}', tags: ['planner'] } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.plans.remove(input.id)
      ctx.events.emit({ kind: 'mutation', path: 'plans' })
      return { removed }
    }),

  applyPlan: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/plans/{id}/apply', tags: ['planner'], summary: 'Write the plan onto the pods: wave-1 pods seeded today, later waves noted with their sow date' } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ seeded: z.array(z.number()), scheduled: z.array(z.object({ slot: z.number(), plantName: z.string(), sowOn: z.string() })) }))
    .mutation(({ ctx, input }) => {
      const plan = ctx.store.plans.get(input.id)
      if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'plan not found' })
      const now = (ctx.now ?? (() => new Date()))()
      const today = now.toISOString().slice(0, 10)
      const podCount = ctx.store.pods.list().length
      const seeded: number[] = []
      const scheduled: { slot: number, plantName: string, sowOn: string }[] = []
      for (const a of podSchedule(plan.layout, plan.sowing)) {
        if (a.slot > podCount) continue
        const sowOn = a.wave?.sowOn ?? today
        if (sowOn <= today) {
          ctx.store.pods.update(a.slot, { plant: a.plantName, plantedAt: today, status: 'seeded', notes: `${a.reason}${a.fallback ? ' (zone fallback)' : ''}` }, now.toISOString())
          seeded.push(a.slot)
        }
        else {
          ctx.store.pods.update(a.slot, { plant: a.plantName, plantedAt: null, status: 'empty', notes: `planned: sow ${a.plantName} on ${sowOn}` }, now.toISOString())
          scheduled.push({ slot: a.slot, plantName: a.plantName, sowOn })
        }
      }
      ctx.store.plans.markApplied(plan.id, now.toISOString())
      if (!ctx.store.grow.current()) ctx.store.grow.start(now.toISOString(), plan.name)
      ctx.events.emit({ kind: 'mutation', path: 'pods' })
      ctx.events.emit({ kind: 'mutation', path: 'grow' })
      return { seeded, scheduled }
    }),

  plant: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/planner/catalog/{id}', tags: ['planner'] } })
    .input(z.object({ id: z.string() }))
    .output(Plant)
    .query(({ input }) => {
      const p = getPlant(input.id)
      if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: `no plant ${input.id}` })
      return p
    }),
})

export { podSchedule }
