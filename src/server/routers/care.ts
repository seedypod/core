import { z } from 'zod'
import { CHORE_IDS, chores } from '../../care/chores'
import { setupReport } from '../../care/setup'
import { TANK_ACTION_KINDS } from '../../store/types'
import { publicProcedure, router } from '../trpc'

const SetupIssue = z.object({
  id: z.enum(['no_light_schedule', 'no_pump_schedule', 'water_sensor_absent', 'water_sensor_suspect']),
  alert: z.string(),
  title: z.string(),
  detail: z.string(),
  fix: z.string(),
})

const Citation = z.object({ note: z.string(), section: z.string(), url: z.string() })
const Chore = z.object({
  id: z.enum(CHORE_IDS),
  title: z.string(),
  state: z.enum(['due', 'soon', 'ok', 'unknown']),
  basis: z.enum(['reading', 'timeline']),
  reason: z.string(),
  dueAt: z.string().nullable(),
  lastDoneAt: z.string().nullable(),
  readings: z.array(z.object({ sensor: z.string(), value: z.number(), unit: z.string(), quality: z.enum(['good', 'stale', 'suspect']), ts: z.string() })),
  citations: z.array(Citation),
  doneKind: z.enum(TANK_ACTION_KINDS),
})

export const careRouter = router({
  setup: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/care/setup', tags: ['care'], summary: 'Setup check (ADR-0029): pods planted with no light or pump schedule on, and a tank level sensor that is absent or suspect' } })
    .output(z.object({ planted: z.number(), issues: z.array(SetupIssue), summary: z.string() }))
    .query(({ ctx }) => setupReport(ctx.store, ctx.hal.snapshot())),
  chores: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/care/chores', tags: ['care'], summary: 'Chores (ADR-0029): thin, trim roots, top off, refresh, feed, clean; each due, soon, ok or unknown, from a trusted reading or a stated calendar guess, with the knowledge notes behind every dose and target' } })
    .output(z.array(Chore))
    .query(({ ctx }) => chores(ctx.store, ctx.hal.snapshot(), (ctx.now ?? (() => new Date()))())),
})
