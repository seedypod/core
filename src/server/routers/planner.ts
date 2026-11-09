import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { BUILTIN, type Catalog, Category, CATALOG_SOURCES, Plant, Zone } from '../../plants/catalog'
import { catalogFor, CustomPlantFields, CustomPlantPatch, customToPlant, plantSlug, SUCCESSION_BY_CATEGORY } from '../../plants/custom'
import { matchOrder } from '../../plants/match'
import { bestSpots, planLayout, sowingPlan } from '../../plants/planner'
import { MODELS, slots, zoneCounts } from '../../plants/zones'
import type { PlanRow, Store } from '../../store/types'
import type { Context } from '../context'
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
  /** First sow date (YYYY-MM-DD): pass it back as `start` to recompute the same schedule. Null when nothing is sown. */
  start: z.string().nullable(),
})
const Candidate = z.object({ plantId: z.string(), plantName: z.string(), confidence: z.number(), reason: z.string().optional() })
const OrderOut = z.object({
  matched: z.array(Candidate.extend({ line: z.string(), name: z.string(), count: z.number(), alternatives: z.array(Candidate) })),
  unmatched: z.array(z.object({ line: z.string(), name: z.string(), count: z.number(), suggestions: z.array(Candidate) })),
  plants: z.array(z.object({ plantId: z.string(), count: z.number() })),
  skipped: z.array(z.string()),
})
const PlanFields = z.object({ name: z.string().min(1).max(60), model: Model, mode: z.enum(['staggered', 'batch']), plants: Request, start: z.string().optional(), overrides: Overrides.optional() })

/** A saved plan as served: the row plus the first sow date its schedule was computed from. */
function withStart(row: PlanRow) {
  return { ...row, start: row.sowing.map(w => w.sowOn).sort()[0] ?? null }
}

/** Lay out and schedule a plan around the pods planted now, and store it. */
function persist(ctx: Context, id: string, p: z.infer<typeof PlanFields>) {
  const catalog = catalogFor(ctx.store)
  const layout = planLayout({ model: p.model, plants: p.plants, occupied: occupiedFromPods(ctx.store.pods.list(), catalog), overrides: p.overrides }, catalog)
  const sowing = sowingPlan(p.plants, p.start ? new Date(p.start) : (ctx.now ?? (() => new Date()))(), p.mode, catalog)
  const row = ctx.store.plans.save({ id, name: p.name, model: p.model, mode: p.mode, request: p.plants, layout, sowing })
  ctx.events.emit({ kind: 'mutation', path: 'plans' })
  return withStart(row)
}

/** Pods currently planted, as slot → catalog plant id (unknown names are kept as occupied). */
function occupiedFromPods(pods: { slot: number, plant: string | null, status: string }[], catalog: Catalog): Record<number, string> {
  const out: Record<number, string> = {}
  for (const p of pods) {
    if (p.status === 'empty' || !p.plant) continue
    const id = catalog.find(p.plant)?.id
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
    .input(z.object({ q: z.string().optional(), category: Category.optional(), zone: Zone.optional(), inStore: z.boolean().optional(), custom: z.boolean().optional() }))
    .output(z.object({ plants: z.array(Plant), sources: z.record(z.string(), z.string()) }))
    .query(({ ctx, input }) => ({ plants: catalogFor(ctx.store).search(input), sources: CATALOG_SOURCES })),

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
    .query(({ ctx, input }) => {
      const catalog = catalogFor(ctx.store)
      return planLayout({ model: input.model, plants: input.plants, occupied: input.respectExisting ? occupiedFromPods(ctx.store.pods.list(), catalog) : {}, overrides: input.overrides }, catalog)
    }),

  bestSpots: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/planner/best-spots', tags: ['planner'], summary: 'Best free slots for one more plant' } })
    .input(z.object({ model: Model, plantId: z.string(), limit: z.number().int().min(1).max(30).default(5) }))
    .output(z.array(z.object({ slot: z.number(), zone: Zone.nullable(), fallback: z.number(), reason: z.string() })))
    .query(({ ctx, input }) => {
      const catalog = catalogFor(ctx.store)
      return bestSpots(input.model, input.plantId, occupiedFromPods(ctx.store.pods.list(), catalog), input.limit, catalog)
    }),

  sowing: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/planner/sowing', tags: ['planner'], summary: 'Staggered sowing dates from Gardyn succession guidance' } })
    .input(z.object({ plants: Request, start: z.string().optional(), mode: z.enum(['staggered', 'batch']).default('staggered') }))
    .output(z.array(Wave))
    .query(({ ctx, input }) => sowingPlan(input.plants, input.start ? new Date(input.start) : (ctx.now ?? (() => new Date()))(), input.mode, catalogFor(ctx.store))),

  plans: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/plans', tags: ['planner'] } })
    .output(z.array(PlanOut))
    .query(({ ctx }) => ctx.store.plans.list().map(withStart)),

  plan: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/plans/{id}', tags: ['planner'], summary: 'One saved plan: request, layout, sowing schedule and overrides' } })
    .input(z.object({ id: z.string() }))
    .output(PlanOut)
    .query(({ ctx, input }) => {
      const plan = ctx.store.plans.get(input.id)
      if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'plan not found' })
      return withStart(plan)
    }),

  matchOrder: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/planner/match-order', tags: ['planner'], summary: 'Match free-text order lines ("Genovese Basil x2") to catalog plants, with confidence and unmatched lines' } })
    .input(z.object({ lines: z.array(z.string().max(500)).min(1).max(200) }))
    .output(OrderOut)
    .query(({ ctx, input }) => matchOrder(input.lines, catalogFor(ctx.store))),

  savePlan: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/plans/{id}', tags: ['planner'], summary: 'Compute and save a layout + sowing plan' } })
    .input(PlanFields.extend({ id: z.string().min(1), mode: z.enum(['staggered', 'batch']).default('staggered') }))
    .output(PlanOut)
    .mutation(({ ctx, input }) => persist(ctx, input.id, input)),

  updatePlan: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/plans/{id}', tags: ['planner'], summary: 'Change a saved plan and recompute it; unspecified fields (including its start date and overrides) stay as saved' } })
    .input(PlanFields.partial().extend({ id: z.string(), overrides: Overrides.nullable().optional() }))
    .output(PlanOut)
    .mutation(({ ctx, input }) => {
      const cur = ctx.store.plans.get(input.id)
      if (!cur) throw new TRPCError({ code: 'NOT_FOUND', message: 'plan not found' })
      const model = input.model ?? cur.model
      const overrides = input.overrides === null ? undefined : input.overrides ?? cur.layout.overrides
      return persist(ctx, cur.id, { name: input.name ?? cur.name, model, mode: input.mode ?? cur.mode, plants: input.plants ?? cur.request, start: input.start ?? withStart(cur).start ?? undefined, overrides })
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
    .query(({ ctx, input }) => {
      const p = catalogFor(ctx.store).get(input.id)
      if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: `no plant ${input.id}` })
      return p
    }),

  addPlant: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/planner/catalog', tags: ['planner'], summary: 'Add a custom plant to the catalog (built-in Gardyn plants are read-only)' } })
    .input(CustomPlantFields.extend({ source: z.enum(['user', 'agent']).default('user') }))
    .output(Plant)
    .mutation(({ ctx, input }) => {
      const id = plantSlug(input.name)
      if (!id) throw new TRPCError({ code: 'BAD_REQUEST', message: 'a plant name needs a letter or digit' })
      checkWindow(input.harvestMonths)
      const catalog = catalogFor(ctx.store)
      const clash = catalog.find(input.name) ?? catalog.get(id)
      if (clash) throw new TRPCError({ code: 'CONFLICT', message: `${clash.name} is already in the catalog (${clash.id}${clash.custom ? ', custom: update it instead' : ', built-in'})` })
      const row = ctx.store.customPlants.upsert({ ...input, id, succession: input.succession ?? SUCCESSION_BY_CATEGORY[input.category] }, now(ctx))
      ctx.events.emit({ kind: 'mutation', path: 'catalog' })
      return customToPlant(row)
    }),

  updatePlant: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/planner/catalog/{id}', tags: ['planner'], summary: 'Edit a custom plant; its id stays the same' } })
    .input(CustomPlantPatch.extend({ id: z.string(), source: z.enum(['user', 'agent']).optional() }))
    .output(Plant)
    .mutation(({ ctx, input }) => {
      const cur = editable(ctx.store, input.id)
      const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }
      if (input.category && !input.succession) next.succession = SUCCESSION_BY_CATEGORY[input.category]
      checkWindow(next.harvestMonths)
      const clash = catalogFor(ctx.store).find(next.name)
      if (clash && clash.id !== cur.id) throw new TRPCError({ code: 'CONFLICT', message: `${clash.name} is already in the catalog (${clash.id})` })
      const row = ctx.store.customPlants.upsert(next, now(ctx))
      ctx.events.emit({ kind: 'mutation', path: 'catalog' })
      return customToPlant(row)
    }),

  removePlant: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/planner/catalog/{id}', tags: ['planner'], summary: 'Remove a custom plant (saved plans keep their layout)' } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      editable(ctx.store, input.id)
      const removed = ctx.store.customPlants.remove(input.id)
      ctx.events.emit({ kind: 'mutation', path: 'catalog' })
      return { removed }
    }),
})

function now(ctx: { now?: () => Date }): string {
  return (ctx.now ?? (() => new Date()))().toISOString()
}

function checkWindow([from, to]: [number, number]) {
  if (from > to) throw new TRPCError({ code: 'BAD_REQUEST', message: 'harvestMonths must be [from, to] with from ≤ to' })
}

/** A custom plant by id; built-in plants are read-only. */
function editable(store: Store, id: string) {
  if (BUILTIN.get(id)) throw new TRPCError({ code: 'FORBIDDEN', message: `${id} is a built-in Gardyn plant; built-in plants are read-only` })
  const cur = store.customPlants.get(id)
  if (!cur) throw new TRPCError({ code: 'NOT_FOUND', message: `no custom plant ${id}` })
  return cur
}

export { podSchedule }
