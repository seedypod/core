import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { FOLLOW_ALERT, redateGermination } from '../../care/follow'
import { cycleDay, MAX_BACKDATE_DAYS, restarted } from '../../grow/grow'
import { harvestOutlook } from '../../grow/harvest'
import { presetSchedules, PUMP_PRESETS, type PumpPreset } from '../../scheduler/pumpPlan'
import { localTime } from '../../scheduler/time'
import { publicProcedure, router } from '../trpc'

/** Midnight at the start of `date` (YYYY-MM-DD) in `timezone`. */
export function zonedMidnight(date: string, timezone: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`)
  const offsetAt = (t: number) => {
    const wall = localTime(new Date(t), timezone)
    return Date.parse(`${wall.date}T00:00:00Z`) + wall.minute * 60_000 - t
  }
  // The offset at the guess can differ from the one at midnight on a DST day, so take it again there.
  const first = guess - offsetAt(guess)
  const at = guess - offsetAt(first)
  // Where a DST jump skips midnight, the day starts at the first instant after the gap.
  return new Date(localTime(new Date(at), timezone).date < date ? first : at)
}

const realDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d)
}

const SowDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startedAt must be a date, YYYY-MM-DD').refine(realDate, 'startedAt is not a real date')

/** Midnight on a sowing day on the unit's calendar, refused when it's after today or too far back to date a cycle from. */
function sowingMidnight(date: string, timezone: string, now: Date): Date {
  const today = localTime(now, timezone).date
  if (date > today) throw new TRPCError({ code: 'BAD_REQUEST', message: `startedAt ${date} is after today (${today})` })
  // By calendar days, as the date picker counts them.
  if ((Date.parse(today) - Date.parse(date)) / 86_400_000 > MAX_BACKDATE_DAYS) throw new TRPCError({ code: 'BAD_REQUEST', message: `startedAt ${date} is more than ${MAX_BACKDATE_DAYS} days ago` })
  return zonedMidnight(date, timezone)
}

const Stage = z.enum(['germination', 'seedling', 'vegetative', 'harvest', 'ended'])
const Cycle = z.object({ id: z.string(), startedAt: z.string(), endedAt: z.string().nullable(), stage: Stage, notes: z.string(), issued: z.array(z.string()) })
const PodStatus = z.enum(['empty', 'seeded', 'growing', 'harvest', 'attention'])
const PodOut = z.object({ slot: z.number(), plant: z.string().nullable(), plantedAt: z.string().nullable(), status: PodStatus, notes: z.string(), updatedAt: z.string(), statusSince: z.string().nullable(), lastHarvestAt: z.string().nullable() })
const Outlook = z.object({
  slot: z.number(),
  plant: z.string().nullable(),
  state: z.enum(['ready', 'soon', 'growing', 'unknown']),
  ageDays: z.number().nullable(),
  cover: z.number().nullable(),
  targetCover: z.number(),
  coverPerDay: z.number().nullable(),
  window: z.object({ start: z.number(), end: z.number(), source: z.enum(['profile', 'camera']) }).nullable(),
  daysToReady: z.number().nullable(),
  daysLeft: z.number().nullable(),
  profile: z.string().nullable(),
  reason: z.string(),
})

export const growRouter = router({
  current: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/grow', tags: ['grow'] } })
    .output(z.object({ cycle: Cycle.nullable(), day: z.number().nullable() }))
    .query(({ ctx }) => {
      const cycle = ctx.store.grow.current()
      return { cycle, day: cycle ? cycleDay(cycle, (ctx.now ?? (() => new Date()))()) : null }
    }),
  start: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/start', tags: ['grow'], summary: 'Start a new grow cycle (ends any open one); startedAt (YYYY-MM-DD, the unit\'s local date) backdates it to the sowing day' } })
    .input(z.object({ notes: z.string().default(''), startedAt: SowDate.optional() }))
    .output(Cycle)
    .mutation(({ ctx, input }) => {
      const now = (ctx.now ?? (() => new Date()))()
      let at = now
      if (input.startedAt) {
        // The sowing day on the unit's calendar: midnight there, not in UTC.
        at = sowingMidnight(input.startedAt, ctx.store.settings.get().timezone, now)
        const open = ctx.store.grow.current()
        if (open && at.getTime() < Date.parse(open.startedAt)) throw new TRPCError({ code: 'BAD_REQUEST', message: `startedAt ${input.startedAt} is before the open cycle began; end it first` })
      }
      const c = ctx.store.grow.start(at.toISOString(), input.notes)
      ctx.events.emit({ kind: 'mutation', path: 'grow' })
      return c
    }),
  setStart: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/start-date', tags: ['grow'], summary: 'Move the open grow cycle\'s start to another sowing day (startedAt, YYYY-MM-DD, the unit\'s local date; not after today); watering that follows the cycle re-dates to it' } })
    .input(z.object({ startedAt: SowDate }))
    .output(Cycle)
    .mutation(({ ctx, input }) => {
      const { store, events } = ctx
      const now = (ctx.now ?? (() => new Date()))()
      const settings = store.settings.get()
      const at = sowingMidnight(input.startedAt, settings.timezone, now)
      const open = store.grow.current()
      // Reminders not yet due by the new day wait again, and the stage is read from it.
      const again = open ? restarted(open, settings, cycleDay({ ...open, startedAt: at.toISOString() }, now)) : null
      const c = again && store.grow.setStart(at.toISOString(), again.stage, again.issued)
      if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'No open grow cycle to move; start one' })
      // The days recorded for begun protocol stages counted from the old sowing day (ADR-0030): read them from the new one.
      store.grow.setProtocol({ stageStarts: {} })
      events.emit({ kind: 'mutation', path: 'grow' })
      // Germination's weekly run goes with it, while watering follows the cycle.
      const moved = redateGermination(store, now)
      if (moved) {
        store.alerts.raise(FOLLOW_ALERT, moved.detail, now.toISOString())
        events.emit({ kind: 'schedule', action: 'changed', id: 'follow:germination' })
        events.emit({ kind: 'mutation', path: `alerts.${FOLLOW_ALERT}` })
      }
      return c
    }),
  startGermination: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/start-germination', tags: ['grow'], summary: 'Start a grow cycle today and put the pump cycles on Germination (15 min at 08:00 once a week, on today\'s weekday), replacing the others; a retry reuses a cycle started today' } })
    .input(z.void())
    .output(Cycle)
    .mutation(({ ctx }) => {
      const { store, events } = ctx
      const now = (ctx.now ?? (() => new Date()))()
      const today = localTime(now, store.settings.get().timezone)
      const open = store.grow.current()
      // Asked again after it got part way: the cycle started today stands.
      const cycle = open && localTime(new Date(open.startedAt), store.settings.get().timezone).date === today.date ? open : store.grow.start(now.toISOString(), '')
      const fresh = presetSchedules(PUMP_PRESETS.find(p => p.id === 'germination') as PumpPreset, { enabled: true, weekday: today.weekday })
      for (const s of fresh) store.schedules.upsert(s)
      for (const s of store.schedules.list()) if (s.kind === 'pump' && !fresh.some(f => f.id === s.id)) store.schedules.remove(s.id)
      events.emit({ kind: 'mutation', path: 'grow' })
      events.emit({ kind: 'schedule', action: 'changed', id: 'start-germination' })
      return cycle
    }),
  setStage: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/stage', tags: ['grow'] } })
    .input(z.object({ stage: Stage }))
    .output(Cycle.nullable())
    .mutation(({ ctx, input }) => {
      const c = ctx.store.grow.setStage(input.stage, (ctx.now ?? (() => new Date()))().toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'grow' })
      return c
    }),
  end: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/grow/end', tags: ['grow'] } })
    .input(z.void())
    .output(Cycle.nullable())
    .mutation(({ ctx }) => {
      const c = ctx.store.grow.end((ctx.now ?? (() => new Date()))().toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'grow' })
      return c
    }),
  history: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/grow/history', tags: ['grow'] } })
    .output(z.array(Cycle))
    .query(({ ctx }) => ctx.store.grow.history()),
  pods: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pods', tags: ['grow'] } })
    .output(z.array(PodOut))
    .query(({ ctx }) => ctx.store.pods.list()),
  updatePod: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/pods/{slot}', tags: ['grow'] } })
    .input(z.object({ slot: z.number().int().min(1).max(60), plant: z.string().nullable().optional(), plantedAt: z.string().nullable().optional(), status: PodStatus.optional(), notes: z.string().optional() }))
    .output(PodOut)
    .mutation(({ ctx, input }) => {
      const { slot, ...patch } = input
      const p = ctx.store.pods.update(slot, patch, (ctx.now ?? (() => new Date()))().toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'pods' })
      return p
    }),
  swapPods: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pods/swap', tags: ['grow'], summary: 'Swap what two pods hold (plant, sow date, status, notes, last cut), after moving their yCubes; camera history stays with each pod position' } })
    .input(z.object({ a: z.number().int().min(1).max(60), b: z.number().int().min(1).max(60) }))
    .output(z.array(PodOut))
    .mutation(({ ctx, input }) => {
      const pods = ctx.store.pods.list()
      const a = pods.find(p => p.slot === input.a)
      const b = pods.find(p => p.slot === input.b)
      if (!a || !b) throw new TRPCError({ code: 'NOT_FOUND', message: `no pod ${a ? input.b : input.a}` })
      if (a.slot === b.slot) return [a, b]
      const ts = (ctx.now ?? (() => new Date()))().toISOString()
      const holds = (p: typeof a) => ({ plant: p.plant, plantedAt: p.plantedAt, status: p.status, notes: p.notes, lastHarvestAt: p.lastHarvestAt })
      const out = [ctx.store.pods.update(a.slot, holds(b), ts), ctx.store.pods.update(b.slot, holds(a), ts)]
      ctx.events.emit({ kind: 'mutation', path: 'pods' })
      return out
    }),
  harvest: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/harvest', tags: ['grow'], summary: 'Harvest outlook per planted pod: ready, soon or growing, from leaf cover and any plant profile (ADR-0022)' } })
    .output(z.array(Outlook))
    .query(({ ctx }) => harvestOutlook(ctx.store, (ctx.now ?? (() => new Date()))())),
  markHarvested: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pods/{slot}/harvested', tags: ['grow'], summary: 'Record a cut: the pod goes back to growing and the camera counts only regrowth' } })
    .input(z.object({ slot: z.number().int().min(1).max(60) }))
    .output(PodOut)
    .mutation(({ ctx, input }) => {
      const ts = (ctx.now ?? (() => new Date()))().toISOString()
      const p = ctx.store.pods.update(input.slot, { status: 'growing', lastHarvestAt: ts }, ts)
      ctx.events.emit({ kind: 'mutation', path: 'pods' })
      return p
    }),
})
