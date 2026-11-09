/**
 * Capture analysers (ADR-0019): the vision counterpart of hald's SensorKind.
 * Each one scores the pods visible in a still and says what it measured, so
 * several can run on the same captures and be compared, and a remote worker
 * can post results under its own id into the same table.
 */
import type { Rect, Rgba } from './greenArea'
import { coverByPod, defaultPodRects, isGreen, isLeafColour } from './greenArea'

export interface MetricInfo {
  /** Stable key, e.g. `green_fraction`. */
  name: string
  label: string
  /** Display unit; omitted for ratios and counts. */
  unit?: string
  description: string
}

/** The serialisable half: what an analyser is, without its code. */
export interface AnalyzerInfo {
  id: string
  version: number
  label: string
  description: string
  metrics: MetricInfo[]
  /** `device` runs on the unit after every capture; `remote` results arrive through the ingest API. */
  runsOn: Array<'device' | 'remote'>
}

/** One measurement of one pod by one analyser. */
export interface PodResult {
  slot: number
  metric: string
  value: number
  /** Small JSON (a threshold, a box, a confidence). Large outputs go in `artifacts`. */
  detail?: Record<string, unknown>
}

/** A large output (a mask, an overlay), stored in the blob sink, never in SQLite. */
export interface Artifact {
  name: string
  bytes: Uint8Array
}

export interface AnalyzerOptions {
  /** Emit large artifacts such as masks; off by default to spare the SD card. */
  artifacts: boolean
}

export interface AnalyzerOutput {
  results: PodResult[]
  artifacts?: Artifact[]
}

export interface CaptureAnalyzer extends AnalyzerInfo {
  run(img: Rgba, pods: Record<number, Rect>, opts: AnalyzerOptions): AnalyzerOutput
}

export function info(a: CaptureAnalyzer): AnalyzerInfo {
  return { id: a.id, version: a.version, label: a.label, description: a.description, metrics: a.metrics, runsOn: a.runsOn }
}

const GREEN_FRACTION: MetricInfo = { name: 'green_fraction', label: 'Green area', description: 'Fraction of the pod crop classified as plant, 0–1.' }

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Version 2 of both analysers (#132) keeps only pixels with a leaf's colour,
 * not a colour cast's, and gives each blob of plant to one pod, so an empty pod
 * under a tinted light or next to a large plant reads about 0.
 */
const V2 = 'Counts only pixels with a leaf\'s hue and saturation, and gives each blob of plant to the pod it grows from, so a neighbour\'s leaves or a tinted light don\'t read as cover.'

/** The original Phase 7.2 baseline: excess green above a fixed threshold. */
export const greenThreshold: CaptureAnalyzer = {
  id: 'green-threshold',
  version: 2,
  label: 'Fixed green threshold',
  description: `Excess-green index (2G − R − B) above a fixed cut-off of 20. Transparent and cheap, but drifts with grow-light colour and exposure. ${V2}`,
  metrics: [GREEN_FRACTION],
  runsOn: ['device'],
  run(img, pods) {
    return { results: perPod(plantMask(img, (r, g, b) => isGreen(r, g, b)), img, pods) }
  },
}

/** Excess green with a per-image Otsu threshold (the PlantCV approach). */
export const exgOtsu: CaptureAnalyzer = {
  id: 'exg-otsu',
  version: 2,
  label: 'Excess green + Otsu',
  description: `Excess-green index with a threshold chosen per image by Otsu's method, so a change in lighting moves the cut-off instead of the result. ${V2}`,
  metrics: [GREEN_FRACTION],
  runsOn: ['device'],
  run(img, pods, opts) {
    const exg = excessGreen(img)
    const threshold = otsu(exg)
    const mask = plantMask(img, (_r, _g, _b, p) => (exg[p] ?? 0) > threshold)
    return { results: perPod(mask, img, pods, { threshold }), artifacts: opts.artifacts ? [{ name: 'mask.pbm', bytes: maskPbm(mask, img.width, img.height, 0) }] : undefined }
  },
}

/** 1 where `test` passes and the pixel has a leaf's colour. */
function plantMask(img: Rgba, test: (r: number, g: number, b: number, p: number) => boolean): Uint8Array {
  const n = img.width * img.height
  const mask = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    const r = img.data[p * 4] ?? 0
    const g = img.data[p * 4 + 1] ?? 0
    const b = img.data[p * 4 + 2] ?? 0
    if (test(r, g, b, p) && isLeafColour(r, g, b)) mask[p] = 1
  }
  return mask
}

function perPod(mask: Uint8Array, img: Rgba, pods: Record<number, Rect>, detail?: Record<string, unknown>): PodResult[] {
  const cover = coverByPod(mask, img.width, img.height, pods)
  return Object.keys(pods).map(Number).map(slot => ({ slot, metric: 'green_fraction', value: round3(cover[slot] ?? 0), ...(detail ? { detail } : {}) }))
}

/** Analysers that run on the unit, in the order they run. */
export const DEVICE_ANALYZERS: CaptureAnalyzer[] = [greenThreshold, exgOtsu]

export const DEFAULT_PRIMARY = greenThreshold.id

export function findAnalyzer(id: string): CaptureAnalyzer | undefined {
  return DEVICE_ANALYZERS.find(a => a.id === id)
}

/** Run every given analyser over one decoded still. */
export function runAnalyzers(img: Rgba, camera: 'upper' | 'lower', analyzers: CaptureAnalyzer[], opts: AnalyzerOptions): Array<AnalyzerOutput & { analyzer: string, version: number }> {
  const pods = defaultPodRects(camera, img.width, img.height)
  return analyzers.map(a => ({ analyzer: a.id, version: a.version, ...a.run(img, pods, opts) }))
}

/** Excess-green index per pixel, shifted into 0–255 (ExG spans −510…510; plant pixels sit well above 0). */
export function excessGreen(img: Rgba): Uint8Array {
  const n = img.width * img.height
  const out = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    const i = p * 4
    const v = 2 * (img.data[i + 1] ?? 0) - (img.data[i] ?? 0) - (img.data[i + 2] ?? 0)
    out[p] = Math.max(0, Math.min(255, (v >> 1) + 128))
  }
  return out
}

/** Otsu's threshold over 8-bit values: the cut that maximises between-class variance. */
export function otsu(values: Uint8Array): number {
  const hist = new Array<number>(256).fill(0)
  for (const v of values) hist[v] = (hist[v] ?? 0) + 1
  const total = values.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * (hist[i] ?? 0)
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t] ?? 0
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * (hist[t] ?? 0)
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > best) {
      best = between
      threshold = t
    }
  }
  // An image with nothing green has no plant class; never call soil "plant" just because it is the brighter half.
  return Math.max(threshold, 128 + 10)
}

/** 1-bit PBM (P4): plant pixels black. Viewable in any image tool, 1/32 the size of RGBA. */
export function maskPbm(exg: Uint8Array, width: number, height: number, threshold: number): Uint8Array {
  const header = new TextEncoder().encode(`P4\n${width} ${height}\n`)
  const rowBytes = Math.ceil(width / 8)
  const out = new Uint8Array(header.length + rowBytes * height)
  out.set(header)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((exg[y * width + x] ?? 0) > threshold) {
        const o = header.length + y * rowBytes + (x >> 3)
        out[o] = (out[o] ?? 0) | (0x80 >> (x & 7))
      }
    }
  }
  return out
}
