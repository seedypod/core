/**
 * Dataset export (ADR-0019 phase 2): the photos, every analyser's results,
 * pod and grow-cycle metadata and the sensor telemetry for one time window,
 * as a tar of JSON/JSONL files. It is the thing you pull to a laptop to
 * measure, recalibrate or train — seedypod's counterpart of sleepypod's
 * sleep-stage dataset script.
 */
import { SensorId } from '../hardware/contract'
import type { Context } from '../server/context'
import type { TarEntry } from './tar'

export interface ExportWindow {
  from: string
  to: string
  /** Include the JPEGs (the bulk of the size). */
  images: boolean
}

export interface DatasetSummary extends ExportWindow {
  captures: number
  analyses: number
  telemetry: number
  /** Bytes of stills in the window, a lower bound on the archive size when images are included. */
  imageBytes: number
}

export const DATASET_FORMAT = { name: 'seedypod-dataset', version: 1 }

const DAY = 86_400_000
const enc = new TextEncoder()
const json = (v: unknown) => enc.encode(`${JSON.stringify(v, null, 2)}\n`)
const jsonl = (rows: unknown[]) => enc.encode(rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))

/** Default window: the last 30 days, which is also the on-device retention for stills. */
export function resolveWindow(now: Date, q: { from?: string, to?: string, images?: boolean }): ExportWindow {
  const to = q.to ? new Date(q.to) : now
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('from and to must be ISO timestamps')
  if (from > to) throw new Error('from is after to')
  return { from: from.toISOString(), to: to.toISOString(), images: q.images ?? true }
}

function capturesIn(ctx: Context, w: ExportWindow) {
  return ctx.store.captures.list(undefined, Number.MAX_SAFE_INTEGER).filter(c => c.ts >= w.from && c.ts <= w.to).reverse()
}

function telemetryIn(ctx: Context, w: ExportWindow) {
  return SensorId.options.flatMap(s => ctx.store.telemetry.range(s, w.from, w.to, Number.MAX_SAFE_INTEGER))
}

export function summarize(ctx: Context, w: ExportWindow): DatasetSummary {
  const captures = capturesIn(ctx, w)
  return {
    ...w,
    captures: captures.length,
    analyses: ctx.store.analyses.range(w.from, w.to).length,
    telemetry: telemetryIn(ctx, w).length,
    imageBytes: captures.reduce((n, c) => n + c.bytes, 0),
  }
}

/** Archive-safe folder name, e.g. `seedypod-kitchen-20261001-20261031`. */
export function datasetName(unit: string, w: ExportWindow): string {
  const day = (ts: string) => ts.slice(0, 10).replace(/-/g, '')
  const slug = unit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'unit'
  return `seedypod-${slug}-${day(w.from)}-${day(w.to)}`
}

/** The archive's files, produced lazily so stills are read one at a time. */
export async function* datasetEntries(ctx: Context, w: ExportWindow): AsyncGenerator<TarEntry> {
  const settings = ctx.store.settings.get()
  const root = datasetName(settings.unitName, w)
  const mtime = (ctx.now?.() ?? new Date()).getTime() / 1000
  const file = (name: string, bytes: Uint8Array): TarEntry => ({ name: `${root}/${name}`, bytes, mtime })

  const captures = capturesIn(ctx, w)
  const analyses = ctx.store.analyses.range(w.from, w.to)
  const telemetry = telemetryIn(ctx, w)
  const system = ctx.hal.snapshot().system

  yield file('manifest.json', json({
    format: DATASET_FORMAT,
    exportedAt: new Date(mtime * 1000).toISOString(),
    window: { from: w.from, to: w.to },
    unit: { name: settings.unitName, id: system?.unitId ?? null, model: system?.model ?? null, timezone: settings.timezone },
    core: ctx.version,
    primaryAnalyzer: settings.primaryAnalyzer,
    analyzers: ctx.analysis.list().map(({ primary, ...a }) => ({ ...a, primary })),
    counts: { captures: captures.length, analyses: analyses.length, telemetry: telemetry.length },
    images: w.images,
  }))
  yield file('README.md', enc.encode(README))
  yield file('captures.jsonl', jsonl(captures.map(c => ({ id: c.id, camera: c.camera, ts: c.ts, bytes: c.bytes, image: w.images && !c.path.startsWith('data:') ? `images/${c.id}.jpg` : null }))))
  yield file('analyses.jsonl', jsonl(analyses))
  yield file('telemetry.jsonl', jsonl(telemetry))
  yield file('pods.json', json(ctx.store.pods.list()))
  yield file('grow_cycles.json', json(ctx.store.grow.history()))

  if (!w.images) return
  for (const c of captures) {
    if (c.path.startsWith('data:')) continue
    const got = await ctx.captures.bytes(c.id)
    if (got) yield file(`images/${c.id}.jpg`, got.bytes)
  }
}

const README = `# seedypod dataset

Exported from a seedypod unit (ADR-0019). Every file covers the window in
\`manifest.json\`.

| File | Contents |
|---|---|
| \`manifest.json\` | Format version, window, unit, core version, analysers and which one is primary, row counts |
| \`captures.jsonl\` | One still per line: \`id\`, \`camera\` (upper/lower), \`ts\`, \`bytes\`, \`image\` (path in this archive, or null) |
| \`analyses.jsonl\` | One result per line: \`captureId\`, \`ts\`, \`camera\`, \`analyzer\`, \`version\`, \`source\` (device/remote), \`slot\`, \`metric\`, \`value\`, \`detail\`, \`artifact\` |
| \`telemetry.jsonl\` | One reading per line: \`ts\`, \`sensor\`, \`value\` (canonical units, see the HAL contract) |
| \`pods.json\` | The 30 pods: plant, planted date, status, notes |
| \`grow_cycles.json\` | Grow cycles with start/end and stage |
| \`images/<id>.jpg\` | The stills, when exported with images |

Pods 1–15 are seen by the upper camera, 16–30 by the lower. Results from an
off-device worker can be posted back with \`POST /api/analyses/results\`
under a new analyser id; they then show up on the unit's Analysis screen
next to the on-device analysers.
`
