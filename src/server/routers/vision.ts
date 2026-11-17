import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { daysSinceSowing } from '../../scheduler/pumpPlan'
import { localTime } from '../../scheduler/time'
import { LABEL_SOURCES, POD_CODE, POD_LABELS, type Pod, type PodLabel, type PodLabelCursor, type PodLabelSource } from '../../store/types'
import { podCodeViews } from '../../vision/podCodes'
import { podOrder, swapPodRecords } from '../../vision/podOrder'
import { shareablePairs, shareUrl, unitFingerprint } from '../../vision/shareCodes'
import { CATALOG } from '../../components/Grow/plants/catalog'
import { podTrends } from '../../vision/analyze'
import { POD_STATE_ID } from '../../vision/podState'
import { seenEmpty } from '../../vision/seenEmpty'
import { suggestLabel, type Suggestion } from '../../vision/suggestLabel'
import { CAMERAS, cameraOf, cameraSlots, clampRegion, DEFAULT_REGIONS, podRegions, type Camera, type PodRegions } from '../../vision/regions'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Code = z.string().regex(POD_CODE, 'a code is four of o | / h')
const CodeView = z.object({
  slot: z.number(),
  camera: z.enum(['upper', 'lower']),
  code: z.string(),
  confidence: z.number(),
  ts: z.string(),
  confirmed: z.string().nullable(),
  recorded: z.string().nullable(),
  shared: z.string().nullable(),
  guess: z.string().nullable(),
  from: z.enum(['own', 'shared', 'record']).nullable(),
  disagrees: z.boolean(),
})
const CodePair = z.object({ code: z.string(), plant: z.string(), confirmedAt: z.string() })
const CodesOut = z.object({ available: z.boolean(), pods: z.array(CodeView), pairs: z.array(CodePair) })
const Plain = z.object({ code: z.string(), plant: z.string() })
const ShareOut = z.object({
  url: z.string().nullable(),
  pairs: z.array(Plain),
  skipped: z.array(Plain),
  crops: z.array(z.object({ slot: z.number(), code: z.string(), plant: z.string() })),
})
const Swap = z.tuple([z.number(), z.number()])
const OrderOut = z.object({
  slots: z.array(z.object({ slot: z.number(), code: z.string(), tower: z.string(), from: z.enum(['own', 'shared']), record: z.string().nullable(), plan: z.string().nullable() })),
  recordSwaps: z.array(Swap),
  recordsUnresolved: z.array(z.number()),
  moves: z.array(Swap),
  movesUnresolved: z.array(z.number()),
  plan: z.object({ id: z.string(), name: z.string() }).nullable(),
  unknown: z.number(),
  key: z.string(),
})
const ReadOut = z.array(z.object({ camera: z.enum(['upper', 'lower']), ts: z.string().nullable(), read: z.number(), error: z.string().nullable() }))
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
const Label = z.object({
  captureId: z.string(),
  ts: z.string(),
  camera: CameraName,
  slot: z.number(),
  label: LabelValue,
  labelledAt: z.string(),
  plant: z.string().nullable(),
  plantedAt: z.string().nullable(),
  source: z.enum(LABEL_SOURCES),
  suggested: LabelValue.nullable(),
  suggestedBy: z.string().nullable(),
  suggestedConfidence: z.number().nullable(),
})
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
const SourceCounts = z.object(Object.fromEntries(LABEL_SOURCES.map(s => [s, z.number()])) as Record<PodLabelSource, z.ZodNumber>)
/** A pod's suggestion, with the photo time of the label it carries. */
const SuggestionOut = z.object({ slot: z.number(), label: LabelValue, by: z.string(), confidence: z.number().nullable(), from: z.string().nullable() })
const PodRef = z.object({ captureId: z.string(), slot: z.number().int().min(1).max(30) })

interface Shot { ts: string, camera: Camera }

/** A capture's time and camera, or a pruned one's from its labels. */
function shotOf(ctx: Context, captureId: string): Shot {
  const capture = ctx.store.captures.get(captureId) ?? ctx.store.podLabels.forCapture(captureId)[0]
  if (!capture) throw new TRPCError({ code: 'NOT_FOUND', message: `no capture ${captureId}` })
  return capture
}

/**
 * The pod's record when a photo on `day` shows it: sown by the photo's local day. A pod only
 * planned (no sowing date, or still empty) or sown after the photo isn't in it. Sowing dates
 * are days, so a pod sown the same day as the photo counts as in it, even if it went in later.
 */
const inPhoto = (pod: Pod | undefined, day: string) => (pod?.plant && pod.plantedAt && pod.status !== 'empty' && pod.plantedAt.slice(0, 10) <= day ? pod : null)

/** What the tagger suggests for each of a photo's pods (#261), by slot. A pod whose suggestion was dismissed on the photo has none. */
function suggestionsFor(ctx: Context, captureId: string, shot: Shot): Map<number, Suggestion> {
  const dismissed = new Set(ctx.store.dismissals.forCapture(captureId).map(d => d.slot))
  const tz = ctx.store.settings.get().timezone
  const dayOf = (ts: string) => localTime(new Date(ts), tz).date
  const day = dayOf(shot.ts)
  const last = new Map(ctx.store.podLabels.lastBefore(shot.ts).map(l => [l.slot, l]))
  const pods = new Map(ctx.store.pods.list().map(p => [p.slot, p]))
  // The newest pod-state version that scored this photo.
  const rows = ctx.store.analyses.forCapture(captureId).filter(r => r.analyzer === POD_STATE_ID && r.metric === 'pod_state')
  const version = Math.max(0, ...rows.map(r => r.version))
  const model = new Map(rows.filter(r => r.version === version).map(r => [r.slot, r.detail]))
  const out = new Map<number, Suggestion>()
  for (const slot of cameraSlots(shot.camera)) {
    if (dismissed.has(slot)) continue
    const pod = inPhoto(pods.get(slot), day)
    const l = last.get(slot)
    const d = model.get(slot)
    const s = suggestLabel({
      plantedAt: pod?.plantedAt ?? null,
      status: pod?.status ?? null,
      last: l ? { label: l.label, ts: l.ts, day: dayOf(l.ts), plantedAt: l.plantedAt } : null,
      model: typeof d?.state === 'string' && typeof d.confidence === 'number' ? { state: d.state, confidence: d.confidence, by: `${POD_STATE_ID}@${version}` } : null,
    })
    if (s) out.set(slot, s)
  }
  return out
}

/** A photo's time and camera, refusing a pod the photo's camera doesn't see. */
function podShot(ctx: Context, captureId: string, slot: number): Shot {
  const shot = shotOf(ctx, captureId)
  if (cameraOf(slot) !== shot.camera) throw new TRPCError({ code: 'BAD_REQUEST', message: `pod ${slot} is not on the ${shot.camera} camera` })
  return shot
}

/** Save a label with the pod's plant as the photo shows it, and how it stands to the pod's suggestion. */
function saveLabel(ctx: Context, captureId: string, shot: Shot, slot: number, label: PodLabel['label'], s: Suggestion | null) {
  const shown = inPhoto(ctx.store.pods.list().find(p => p.slot === slot), localTime(new Date(shot.ts), ctx.store.settings.get().timezone).date)
  ctx.store.podLabels.set({
    captureId,
    ts: shot.ts,
    camera: shot.camera,
    slot,
    label,
    labelledAt: (ctx.now?.() ?? new Date()).toISOString(),
    plant: shown?.plant ?? null,
    plantedAt: shown?.plantedAt ?? null,
    source: s ? (s.label === label ? 'accepted' : 'corrected') : 'picked',
    suggested: s?.label ?? null,
    suggestedBy: s?.by ?? null,
    suggestedConfidence: s?.confidence ?? null,
  })
}

const Point = z.object({ ts: z.string(), value: z.number(), captureId: z.string() })

export const visionRouter = router({
  podTrends: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods', tags: ['vision'], summary: 'Per-pod green-area trend from the primary analyser' } })
    .input(z.object({ analyzer: z.string().optional() }).optional())
    .output(z.array(Trend))
    .query(({ ctx, input }) => podTrends(ctx.store, 30, input?.analyzer)),
  seenEmpty: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/seen-empty', tags: ['vision'], summary: 'Pods the cameras see empty though their record holds a plant' } })
    .output(z.array(z.object({ slot: z.number(), confidence: z.number(), ts: z.string() })))
    .query(({ ctx }) => seenEmpty(ctx.store, ctx.now?.() ?? new Date())),
  podSeries: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pods/{slot}', tags: ['vision'] } })
    .input(z.object({ slot: z.number().int().min(1).max(60) }))
    .output(z.array(z.object({ ts: z.string(), green: z.number(), captureId: z.string() })))
    .query(({ ctx, input }) => ctx.store.analyses.series({ analyzer: ctx.store.settings.get().primaryAnalyzer, slot: input.slot, metric: 'green_fraction' })
      .map(p => ({ ts: p.ts, green: p.value, captureId: p.captureId }))),
  allPodSeries: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/series', tags: ['vision'], summary: 'Every pod\'s green-area series from the primary analyser, for comparing pods side by side' } })
    .input(z.object({ limit: z.number().int().min(1).max(1000).default(200) }).optional())
    .output(z.array(z.object({ slot: z.number(), points: z.array(z.object({ ts: z.string(), green: z.number() })) })))
    .query(({ ctx, input }) => {
      const analyzer = ctx.store.settings.get().primaryAnalyzer
      return Array.from({ length: 30 }, (_, i) => ({
        slot: i + 1,
        points: ctx.store.analyses.series({ analyzer, slot: i + 1, metric: 'green_fraction', limit: input?.limit ?? 200 }).map(p => ({ ts: p.ts, green: p.value })),
      })).filter(s => s.points.length > 0)
    }),
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
    .output(z.object({
      counts: LabelCounts,
      pods: z.number(),
      /** How the labels were saved: picked with no suggestion, or a suggestion accepted or corrected. */
      sources: SourceCounts,
      /** Each suggester on the reviewed labels: how often it was accepted or corrected, and the share right. */
      suggesters: z.array(z.object({ by: z.string(), accepted: z.number(), corrected: z.number(), right: z.number() })),
      captures: z.array(z.object({ captureId: z.string(), ts: z.string(), camera: CameraName, pods: z.number() })),
    }))
    .query(({ ctx, input }) => {
      const counts = ctx.store.podLabels.counts()
      const sources = Object.fromEntries(LABEL_SOURCES.map(s => [s, 0])) as Record<PodLabelSource, number>
      const by = new Map<string, { by: string, accepted: number, corrected: number }>()
      for (const r of ctx.store.podLabels.bySource()) {
        sources[r.source] += r.n
        // A picked label had no suggestion; the others always name their suggester.
        if (r.source === 'picked') continue
        const k = String(r.suggestedBy)
        const s = by.get(k) ?? { by: k, accepted: 0, corrected: 0 }
        s[r.source] += r.n
        by.set(k, s)
      }
      return {
        counts,
        pods: Object.values(counts).reduce((n, c) => n + c, 0),
        sources,
        suggesters: [...by.values()].map(s => ({ ...s, right: Math.round((s.accepted / (s.accepted + s.corrected)) * 1000) / 1000 })),
        captures: ctx.store.podLabels.captures(input?.limit ?? 50),
      }
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
  suggestions: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/captures/{captureId}/suggestions', tags: ['vision'], summary: 'The tagger\'s suggested label for each pod in one capture (#261): the pod\'s last label on an earlier photo, or pod-state at 0.8 or more. Pods whose suggestion was dismissed are left out. A suggestion is not a label until accepted' } })
    .input(z.object({ captureId: z.string() }))
    .output(z.array(SuggestionOut))
    .query(({ ctx, input }) => [...suggestionsFor(ctx, input.captureId, shotOf(ctx, input.captureId))].map(([slot, s]) => ({ slot, ...s }))),
  acceptSuggestions: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/vision/captures/{captureId}/suggestions/accept', tags: ['vision'], summary: 'Accept the rest (#261): save every unlabelled pod\'s suggestion in one capture as accepted; pods with no suggestion, or a dismissed one, stay unlabelled' } })
    .input(z.object({ captureId: z.string() }))
    .output(z.object({ captureId: z.string(), slots: z.array(z.number()) }))
    .mutation(({ ctx, input }) => {
      const shot = shotOf(ctx, input.captureId)
      const labelled = new Set(ctx.store.podLabels.forCapture(input.captureId).map(l => l.slot))
      const slots: number[] = []
      for (const [slot, s] of suggestionsFor(ctx, input.captureId, shot)) {
        if (labelled.has(slot)) continue
        saveLabel(ctx, input.captureId, shot, slot, s.label, s)
        slots.push(slot)
      }
      if (slots.length) ctx.events.emit({ kind: 'mutation', path: 'labels' })
      return { captureId: input.captureId, slots }
    }),
  dismissals: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/captures/{captureId}/suggestions/dismissals', tags: ['vision'], summary: 'The pods whose suggestion was dismissed on one capture (#261), by slot: not visible there, or not a pod. A dismissal is not a label' } })
    .input(z.object({ captureId: z.string() }))
    .output(z.array(z.object({ slot: z.number(), dismissedAt: z.string() })))
    .query(({ ctx, input }) => ctx.store.dismissals.forCapture(input.captureId).map(({ slot, dismissedAt }) => ({ slot, dismissedAt }))),
  dismissSuggestion: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/vision/captures/{captureId}/suggestions/{slot}/dismissal', tags: ['vision'], summary: 'Dismiss one pod\'s suggestion on one capture (#261), for a pod that can\'t be seen there or a box that isn\'t on a pod: suggestions leave it out and Accept the rest skips it. Nothing is labelled' } })
    .input(PodRef)
    .output(z.object({ captureId: z.string(), slot: z.number(), dismissedAt: z.string() }))
    .mutation(({ ctx, input }) => {
      const shot = podShot(ctx, input.captureId, input.slot)
      const d = ctx.store.dismissals.dismiss({ captureId: input.captureId, ts: shot.ts, slot: input.slot, dismissedAt: (ctx.now?.() ?? new Date()).toISOString() })
      ctx.events.emit({ kind: 'mutation', path: 'labels' })
      return { captureId: d.captureId, slot: d.slot, dismissedAt: d.dismissedAt }
    }),
  restoreSuggestion: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/vision/captures/{captureId}/suggestions/{slot}/dismissal', tags: ['vision'], summary: 'Bring back a pod\'s dismissed suggestion on one capture (#261)' } })
    .input(PodRef)
    .output(z.object({ captureId: z.string(), slot: z.number(), restored: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const restored = ctx.store.dismissals.restore(input.captureId, input.slot)
      if (restored) ctx.events.emit({ kind: 'mutation', path: 'labels' })
      return { captureId: input.captureId, slot: input.slot, restored }
    }),
  setLabel: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/vision/captures/{captureId}/labels/{slot}', tags: ['vision'], summary: 'Label one pod in a capture for training (ADR-0019); null clears the label. It is saved as accepted when it matches the pod\'s suggestion, corrected when it differs, and picked with none (#261)' } })
    .input(z.object({ captureId: z.string(), slot: z.number().int().min(1).max(30), label: LabelValue.nullable() }))
    .output(z.object({ captureId: z.string(), slot: z.number(), label: LabelValue.nullable() }))
    .mutation(({ ctx, input }) => {
      // A pruned photo's labels can still be changed or removed: they carry its time and camera.
      const shot = podShot(ctx, input.captureId, input.slot)
      if (input.label === null) ctx.store.podLabels.remove(input.captureId, input.slot)
      else saveLabel(ctx, input.captureId, shot, input.slot, input.label, suggestionsFor(ctx, input.captureId, shot).get(input.slot) ?? null)
      ctx.events.emit({ kind: 'mutation', path: 'labels' })
      return { captureId: input.captureId, slot: input.slot, label: input.label }
    }),
  podCodes: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pod-codes', tags: ['vision'], summary: 'yCube dot codes (#224): each pod a code was read under, with the plant the owner confirmed for it (or null), the shared table\'s confirmed plant (#259), its record\'s plant, and the guess in that order; and every confirmed code → plant pair' } })
    .output(CodesOut)
    .query(({ ctx }) => ({ available: ctx.podCodes.available, pods: podCodeViews(ctx.store) as Array<z.infer<typeof CodeView>>, pairs: ctx.store.podCodes.pairs() })),
  readPodCodes: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/vision/pod-codes/read', tags: ['vision'], summary: 'Take a full-size pod-ID still on each camera and read its dot codes (#224); slow on a Pi Zero' } })
    .output(ReadOut)
    .mutation(({ ctx }) => {
      if (!ctx.podCodes.available) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'podvision isn\'t installed, so dot codes can\'t be read' })
      return ctx.podCodes.readAll()
    }),
  confirmPodCode: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/vision/pod-codes/{code}', tags: ['vision'], summary: 'Say which plant a dot code is (#224): confirms a guess or corrects it. Records and plans are left alone' } })
    .input(z.object({ code: Code, plant: z.string().trim().min(1).max(80) }))
    .output(CodePair)
    .mutation(({ ctx, input }) => {
      const pair = ctx.podCodes.confirm(input.code, input.plant, (ctx.now?.() ?? new Date()).toISOString())
      ctx.events.emit({ kind: 'mutation', path: 'podCodes' })
      return pair
    }),
  podCodeShare: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pod-codes/share', tags: ['vision'], summary: 'Share pod codes (#259): a link to the pod-codes issue form pre-filled with the confirmed pairs whose plant is in the catalog, the app version and a one-way hash of the unit id, for the owner\'s browser to open; and the read pods whose crops can go with it. Core never contacts GitHub' } })
    .output(ShareOut)
    .query(async ({ ctx }) => {
      const { pairs, skipped } = shareablePairs(ctx.store.podCodes.pairs(), CATALOG.map(c => c.name))
      const unitId = ctx.hal.snapshot().system?.unitId
      const fingerprint = unitId ? await unitFingerprint(unitId) : null
      const plant = new Map(pairs.map(p => [p.code, p.plant]))
      const crops = ctx.store.podCodes.reads().flatMap(r => (r.code && plant.has(r.code) ? [{ slot: r.slot, code: r.code, plant: plant.get(r.code) as string }] : []))
      return { url: pairs.length ? shareUrl({ pairs, version: ctx.version, fingerprint }) : null, pairs, skipped, crops }
    }),
  forgetPodCode: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/vision/pod-codes/{code}', tags: ['vision'], summary: 'Forget a confirmed dot code → plant pair (#224)' } })
    .input(z.object({ code: Code }))
    .output(z.object({ forgotten: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const forgotten = ctx.store.podCodes.forget(input.code)
      if (forgotten) ctx.events.emit({ kind: 'mutation', path: 'podCodes' })
      return { forgotten }
    }),
  podOrder: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/vision/pod-order', tags: ['vision'], summary: 'Pods out of order (#224): where a known dot code (the owner\'s pair, else the shared table\'s) disagrees with the pod record or the active plan, with the record swaps that match the tower and the physical swaps that match the plan; null when all agree' } })
    .output(OrderOut.nullable())
    .query(({ ctx }) => podOrder(ctx.store)),
  fixPodOrder: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/vision/pod-order/fix', tags: ['vision'], summary: 'Update the pod records to match the tower (#224): applies the record swaps shown for `key`; each plant keeps its sowing date and status' } })
    .input(z.object({ key: z.string() }))
    .output(z.object({ swapped: z.array(Swap), unresolved: z.array(z.number()) }))
    .mutation(({ ctx, input }) => {
      const order = podOrder(ctx.store)
      if (!order || order.key !== input.key) throw new TRPCError({ code: 'CONFLICT', message: 'what\'s out of order has changed since it was shown; look again' })
      const ts = (ctx.now?.() ?? new Date()).toISOString()
      for (const [a, b] of order.recordSwaps) swapPodRecords(ctx.store, a, b, ts)
      if (order.recordSwaps.length) ctx.events.emit({ kind: 'mutation', path: 'pods' })
      return { swapped: order.recordSwaps, unresolved: order.recordsUnresolved }
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
