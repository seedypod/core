import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { daysSinceSowing } from '../../scheduler/pumpPlan'
import { localTime } from '../../scheduler/time'
import { POD_LABELS, type PodLabel, type PodLabelCursor } from '../../store/types'
import { podTrends } from '../../vision/analyze'
import { CAMERAS, cameraOf, cameraSlots, clampRegion, DEFAULT_REGIONS, podRegions, type Camera, type PodRegions } from '../../vision/regions'
import { publicProcedure, router } from '../trpc'

const Trend = z.object({ slot: z.number(), green: z.number().nullable(), verdict: z.enum(['growing', 'stalled', 'declining', 'unknown']), slope: z.number(), samples: z.number(), recent: z.array(z.number()) })
const Metric = z.object({ name: z.string(), label: z.string(), unit: z.string().optional(), description: z.string() })
const Source = z.enum(['device', 'remote'])
const Analyzer = z.object({
  id: z.string(),
  version: z.number(),
  label: z.string(),
  description: z.string(),
  metrics: z.array(Metric),
  runsOn: z.array(Source),
  /** Why an on-device analyser is off, e.g. no weights file (#185). */
  disabled: z.string().optional(),
  source: Source,
  primary: z.boolean(),
  rows: z.number(),
  captures: z.number(),
  firstTs: z.string().nullable(),
  lastTs: z.string().nullable(),
})
const Status = z.object({
  running: z.string().nullable(),
  waiting: z.array(z.string()),
  dropped: z.number(),
  failed: z.number(),
  backfill: z.object({ analyzer: z.string(), done: z.number(), total: z.number() }).nullable(),
})
const Result = z.object({
  captureId: z.string(),
  ts: z.string(),
  camera: z.enum(['upper', 'lower']),
  analyzer: z.string(),
  version: z.number(),
  source: Source,
  slot: z.number(),
  metric: z.string(),
  value: z.number(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  artifact: z.string().nullable(),
})
const CameraName = z.enum(['upper', 'lower'])
const Region = z.object({ slot: z.number().int(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
const CameraRegions = z.object({ camera: CameraName, calibrated: z.boolean(), regions: z.array(Region.extend({ moved: z.boolean() })) })

/** One camera's boxes as rows, each marked moved when it isn't the measured default. */
function regionRows(camera: Camera, own: PodRegions | undefined) {
  const boxes = podRegions(camera, { [camera]: own })
  return { camera, calibrated: !!own && Object.keys(own).length > 0, regions: cameraSlots(camera).map(slot => ({ slot, ...(boxes[slot] as PodRegions[number]), moved: !!own?.[slot] })) }
}

const LabelValue = z.enum(POD_LABELS)
const Label = z.object({ captureId: z.string(), ts: z.string(), camera: CameraName, slot: z.number(), label: LabelValue, labelledAt: z.string(), plant: z.string().nullable(), plantedAt: z.string().nullable() })
/** A label with the pod's age when the photo was taken and where its photo is (null once pruned). */
const LabelEntry = Label.extend({ daysSinceSowing: z.number().nullable(), url: z.string().nullable() })

/** A page cursor is the last row's `ts|captureId|slot`. */
const cursorOf = (l: PodLabel) => `${l.ts}|${l.captureId}|${l.slot}`
function parseCursor(c: string): PodLabelCursor {
  const parts = c.split('|')
  const slot = Number(parts.pop())
  const [ts, ...id] = parts
  if (!ts || !id.length || !Number.isInteger(slot)) throw new TRPCError({ code: 'BAD_REQUEST', message: `bad cursor ${c}` })
  return { ts, captureId: id.join('|'), slot }
}
const LabelCounts = z.object(Object.fromEntries(POD_LABELS.map(l => [l, z.number()])) as Record<typeof POD_LABELS[number], z.ZodNumber>)

const Point = z.object({ ts: z.string(), value: z.number(), captureId: z.string() })

export const visionRouter = router({
  podTrends: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods', tags: ['vision'], summary: 'Per-pod green-area trend from the primary analyser' } })
    .input(z.object({ analyzer: z.string().optional() }).optional())
    .output(z.array(Trend))
    .query(({ ctx, input }) => podTrends(ctx.store, 30, input?.analyzer)),
  podSeries: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods/{slot}', tags: ['vision'] } })
    .input(z.object({ slot: z.number().int().min(1).max(60) }))
    .output(z.array(z.object({ ts: z.string(), green: z.number(), captureId: z.string() })))
    .query(({ ctx, input }) => ctx.store.analyses.series({ analyzer: ctx.store.settings.get().primaryAnalyzer, slot: input.slot, metric: 'green_fraction' })
      .map(p => ({ ts: p.ts, green: p.value, captureId: p.captureId }))),
  analyzers: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/analyzers', tags: ['vision'], summary: 'Analysers on the unit and any that posted results, with row counts and which is primary' } })
    .output(z.array(Analyzer))
    .query(({ ctx }) => ctx.analysis.list()),
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/status', tags: ['vision'], summary: 'Analysis queue: running, waiting, dropped, failed, re-run progress' } })
    .output(Status)
    .query(({ ctx }) => ctx.analysis.status()),
  compare: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/compare/{slot}', tags: ['vision'], summary: 'One pod\'s series from every analyser@version, for side-by-side comparison' } })
    .input(z.object({ slot: z.number().int().min(1).max(60), metric: z.string().default('green_fraction'), limit: z.number().int().min(1).max(1000).default(200) }))
    .output(z.array(z.object({ analyzer: z.string(), version: z.number(), source: Source, points: z.array(Point) })))
    .query(({ ctx, input }) => ctx.store.analyses.stats()
      .map(s => ({ analyzer: s.analyzer, version: s.version, source: s.source, points: ctx.store.analyses.series({ analyzer: s.analyzer, version: s.version, slot: input.slot, metric: input.metric, limit: input.limit }) }))
      .filter(s => s.points.length > 0)),
  capture: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/captures/{captureId}', tags: ['vision'], summary: 'Every analyser\'s results for one capture' } })
    .input(z.object({ captureId: z.string() }))
    .output(z.array(Result))
    .query(({ ctx, input }) => ctx.store.analyses.forCapture(input.captureId)),
  setPrimary: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/vision/primary', tags: ['vision'], summary: 'Choose the analyser that drives pod trends' } })
    .input(z.object({ analyzer: z.string() }))
    .output(z.object({ analyzer: z.string() }))
    .mutation(({ ctx, input }) => {
      const known = ctx.analysis.list().find(a => a.id === input.analyzer && a.metrics.some(m => m.name === 'green_fraction'))
        ?? ctx.store.analyses.stats().find(s => s.analyzer === input.analyzer)
      if (!known) throw new TRPCError({ code: 'NOT_FOUND', message: `no analyser ${input.analyzer}` })
      ctx.store.settings.update({ primaryAnalyzer: input.analyzer })
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      return { analyzer: input.analyzer }
    }),
  rerun: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/vision/analyzers/{analyzer}/rerun', tags: ['vision'], summary: 'Re-score stored captures with one on-device analyser, in the background' } })
    .input(z.object({ analyzer: z.string(), limit: z.number().int().min(1).max(5000).default(2000) }))
    .output(z.object({ captures: z.number() }))
    .mutation(({ ctx, input }) => {
      try {
        return { captures: ctx.analysis.rerun(input.analyzer, input.limit) }
      }
      catch (e) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (e as Error).message })
      }
    }),
  labels: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/captures/{captureId}/labels', tags: ['vision'], summary: 'The grower\'s label for each pod in one capture (empty, seeded, sprouted, growing, ready or unhealthy), with the pod\'s plant when it was labelled' } })
    .input(z.object({ captureId: z.string() }))
    .output(z.array(Label))
    .query(({ ctx, input }) => ctx.store.podLabels.forCapture(input.captureId)),
  labelStats: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/labels', tags: ['vision'], summary: 'How many pods carry each label, and the labelled captures, newest first' } })
    .input(z.object({ limit: z.number().int().min(1).max(500).default(50) }).optional())
    .output(z.object({ counts: LabelCounts, pods: z.number(), captures: z.array(z.object({ captureId: z.string(), ts: z.string(), camera: CameraName, pods: z.number() })) }))
    .query(({ ctx, input }) => {
      const counts = ctx.store.podLabels.counts()
      return { counts, pods: Object.values(counts).reduce((n, c) => n + c, 0), captures: ctx.store.podLabels.captures(input?.limit ?? 50) }
    }),
  labelList: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/labels/pods', tags: ['vision'], summary: 'Every labelled pod, newest photo first, with its plant and age then; pass next back as cursor for the following page' } })
    .input(z.object({ label: LabelValue.optional(), camera: CameraName.optional(), limit: z.number().int().min(1).max(500).default(60), cursor: z.string().optional() }))
    .output(z.object({ labels: z.array(LabelEntry), next: z.string().nullable() }))
    .query(({ ctx, input }) => {
      const rows = ctx.store.podLabels.list({ label: input.label, camera: input.camera, limit: input.limit + 1, before: input.cursor ? parseCursor(input.cursor) : undefined })
      const page = rows.slice(0, input.limit)
      const urls = new Map<string, string | null>()
      const urlOf = (id: string) => {
        if (!urls.has(id)) {
          const c = ctx.store.captures.get(id)
          urls.set(id, c ? (c.path.startsWith('data:') ? c.path : `/api/captures/${c.id}.jpg`) : null)
        }
        return urls.get(id) ?? null
      }
      return {
        labels: page.map(l => ({ ...l, daysSinceSowing: daysSinceSowing(null, [l.plantedAt], new Date(l.ts), 'UTC'), url: urlOf(l.captureId) })),
        next: rows.length > input.limit && page.length ? cursorOf(page[page.length - 1] as PodLabel) : null,
      }
    }),
  setLabel: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/vision/captures/{captureId}/labels/{slot}', tags: ['vision'], summary: 'Label one pod in a capture for training (ADR-0019); null clears the label' } })
    .input(z.object({ captureId: z.string(), slot: z.number().int().min(1).max(30), label: LabelValue.nullable() }))
    .output(z.object({ captureId: z.string(), slot: z.number(), label: LabelValue.nullable() }))
    .mutation(({ ctx, input }) => {
      // A pruned photo's labels can still be changed or removed: they carry its time and camera.
      const capture = ctx.store.captures.get(input.captureId) ?? ctx.store.podLabels.forCapture(input.captureId)[0]
      if (!capture) throw new TRPCError({ code: 'NOT_FOUND', message: `no capture ${input.captureId}` })
      if (cameraOf(input.slot) !== capture.camera) throw new TRPCError({ code: 'BAD_REQUEST', message: `pod ${input.slot} is not on the ${capture.camera} camera` })
      if (input.label === null) ctx.store.podLabels.remove(input.captureId, input.slot)
      else {
        // The pod's plant goes with the label when it was sown by the photo's local day: a pod only
        // planned (no sowing date, or still empty) or sown after the photo isn't in it. Sowing dates
        // are days, so a pod sown the same day as the photo counts as in it, even if it went in later.
        const pod = ctx.store.pods.list().find(p => p.slot === input.slot)
        const day = localTime(new Date(capture.ts), ctx.store.settings.get().timezone).date
        const shown = pod?.plant && pod.plantedAt && pod.status !== 'empty' && pod.plantedAt.slice(0, 10) <= day ? pod : null
        ctx.store.podLabels.set({
          captureId: input.captureId,
          ts: capture.ts,
          camera: capture.camera,
          slot: input.slot,
          label: input.label,
          labelledAt: (ctx.now?.() ?? new Date()).toISOString(),
          plant: shown?.plant ?? null,
          plantedAt: shown?.plantedAt ?? null,
        })
      }
      ctx.events.emit({ kind: 'mutation', path: 'labels' })
      return { captureId: input.captureId, slot: input.slot, label: input.label }
    }),
  regions: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/regions', tags: ['vision'], summary: 'Each pod\'s box on each camera\'s stills, as fractions of the frame: the measured defaults or the owner\'s calibration' } })
    .output(z.array(CameraRegions))
    .query(({ ctx }) => {
      const own = ctx.store.settings.get().podRegions
      return CAMERAS.map(c => regionRows(c, own?.[c]))
    }),
  setRegions: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/vision/regions/{camera}', tags: ['vision'], summary: 'Calibrate one camera\'s pod boxes; boxes left out keep their defaults, and null resets the camera' } })
    .input(z.object({ camera: CameraName, regions: z.array(Region).max(15).nullable() }))
    .output(CameraRegions)
    .mutation(({ ctx, input }) => {
      const slots = cameraSlots(input.camera)
      const stray = input.regions?.find(r => !slots.includes(r.slot))
      if (stray) throw new TRPCError({ code: 'BAD_REQUEST', message: `pod ${stray.slot} is not on the ${input.camera} camera` })
      const own: PodRegions = {}
      for (const { slot, ...box } of input.regions ?? []) {
        const r = clampRegion(box)
        const d = DEFAULT_REGIONS[input.camera][slot] as PodRegions[number]
        // A box put back where it started is a default again, not a calibration.
        if (r.x !== d.x || r.y !== d.y || r.w !== d.w || r.h !== d.h) own[slot] = r
      }
      const others = Object.entries(ctx.store.settings.get().podRegions ?? {}).filter(([c]) => c !== input.camera)
      const all = Object.fromEntries(Object.keys(own).length > 0 ? [...others, [input.camera, own]] : others)
      ctx.store.settings.update({ podRegions: Object.keys(all).length > 0 ? all : null })
      ctx.events.emit({ kind: 'mutation', path: 'regions' })
      return regionRows(input.camera, own)
    }),
})
