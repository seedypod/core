/**
 * `pod-state` (#185): a small CNN, trained off the unit (seedypod/training),
 * that names each pod's state from its crop. It is an analyser like the
 * rule-based ones; only the pixels it reads and the forward pass differ.
 *
 * The crop is the same integer window the rule-based analysers read (floor of
 * the box's top-left, ceil of its bottom-right, clamped to the frame), shrunk
 * to the model's input by averaging the source pixels that fall in each output
 * cell. The training repo's loader does exactly this, so the model sees on the
 * unit what it saw in training.
 */
import type { CaptureAnalyzer, MetricInfo, PodResult } from './analyzer'
import { forward, ModelError, parseModel, softmax, type CnnModel, type ModelInput } from './cnn'
import type { Rect, Rgba } from './greenArea'

export const POD_STATE_ID = 'pod-state'
export const POD_STATES = ['empty', 'sprouted', 'growing', 'ready', 'unhealthy'] as const

const METRICS: MetricInfo[] = [
  { name: 'pod_state', label: 'Pod state', description: 'Index of the most likely class in the model\'s class list (detail.state names it).' },
  { name: 'pod_state_confidence', label: 'Confidence', description: 'The model\'s probability for that class, 0–1.' },
]

/** The integer pixel window of a box, clamped to the frame: what every analyser reads, and at least one pixel. */
export function cropWindow(rect: Rect, width: number, height: number) {
  const x0 = Math.min(width - 1, Math.max(0, Math.floor(rect.x)))
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(rect.y)))
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w))
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h))
  return { x0, y0, x1: Math.max(x0 + 1, x1), y1: Math.max(y0 + 1, y1) }
}

/**
 * One pod's crop as the model's normalised HWC input. Output cell (oy, ox)
 * averages source rows floor(y0 + oy·h/H) … floor(y0 + (oy+1)·h/H) − 1 (at
 * least one) and the same for columns, where h is the window's height.
 */
export function cropInput(img: Rgba, rect: Rect, inp: ModelInput, out = new Float32Array(inp.width * inp.height * inp.channels)): Float32Array {
  const { x0, y0, x1, y1 } = cropWindow(rect, img.width, img.height)
  const sw = x1 - x0
  const sh = y1 - y0
  const C = inp.channels
  const span = (o: number, n: number, len: number, start: number, limit: number) => {
    const a = Math.min(limit - 1, Math.floor(start + (o * len) / n))
    return [a, Math.min(limit, Math.max(a + 1, Math.floor(start + ((o + 1) * len) / n)))] as const
  }
  for (let oy = 0; oy < inp.height; oy++) {
    const [ya, yb] = span(oy, inp.height, sh, y0, y1)
    for (let ox = 0; ox < inp.width; ox++) {
      const [xa, xb] = span(ox, inp.width, sw, x0, x1)
      const o = (oy * inp.width + ox) * C
      const n = (yb - ya) * (xb - xa)
      for (let c = 0; c < C; c++) {
        let s = 0
        for (let y = ya; y < yb; y++) {
          for (let x = xa; x < xb; x++) s += img.data[(y * img.width + x) * 4 + c] as number
        }
        out[o + c] = (s / n / inp.scale - (inp.mean[c] as number)) / (inp.std[c] as number)
      }
    }
  }
  return out
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Mean of R, G and B over a still, 0–1, from every 7th pixel (plenty for telling the light was off). */
export function brightness(img: Rgba): number {
  let sum = 0
  let n = 0
  for (let p = 0; p < img.width * img.height; p += 7) {
    sum += (img.data[p * 4] as number) + (img.data[p * 4 + 1] as number) + (img.data[p * 4 + 2] as number)
    n += 3
  }
  return n ? sum / n / 255 : 0
}

/** Score each pod: its most likely state, the confidence, and every class's probability in `detail`. Nothing for a dark still. */
export function classifyPods(model: CnnModel, img: Rgba, pods: Record<number, Rect>): PodResult[] {
  const { classes, input, revision, minBrightness } = model.file
  // A still taken with the grow light off says nothing about the pods, and the model was never trained on one.
  if (minBrightness !== undefined && brightness(img) < minBrightness) return []
  const buf = new Float32Array(input.width * input.height * input.channels)
  return Object.keys(pods).map(Number).flatMap((slot) => {
    const p = softmax(forward(model, cropInput(img, pods[slot] as Rect, input, buf)))
    let best = 0
    for (let i = 1; i < p.length; i++) if ((p[i] as number) > (p[best] as number)) best = i
    return podStateRows(slot, p, best, classes, revision)
  })
}

/** One pod's rows: the class index, its probability as the confidence, and every class's probability in `detail`. podvision's results (#191) are stored through this too. */
export function podStateRows(slot: number, p: ArrayLike<number>, best: number, classes: string[], revision: string): PodResult[] {
  const confidence = round3(p[best] as number)
  const probabilities = Object.fromEntries(classes.map((c, i) => [c, round3(p[i] as number)]))
  const detail = { state: classes[best], confidence, probabilities, revision }
  return [
    { slot, metric: 'pod_state', value: best, detail },
    { slot, metric: 'pod_state_confidence', value: confidence },
  ]
}

/** What the analyser listing says when it can't run. */
export const NO_WEIGHTS = 'No weights file is installed, so this analyser is off.'

/** Which analyser a revision runs as: `pod-state` for the shipped model, its own id for an uploaded one (#186). */
export interface RunsAs { id: string, label: string }

const SHIPPED: RunsAs = { id: POD_STATE_ID, label: 'Pod state (learned)' }

/**
 * The pod-state analyser for a weights file, or a disabled one that says why
 * (no file, or one that failed to parse). A disabled analyser stays listed so
 * the Analysis screen can say it is off.
 */
export function podStateAnalyzer(model: CnnModel | null, disabled: string = NO_WEIGHTS, as: RunsAs = SHIPPED): CaptureAnalyzer {
  const base = {
    id: as.id,
    label: as.label,
    metrics: METRICS,
    runsOn: ['device'] as Array<'device' | 'remote'>,
  }
  if (!model) {
    return {
      ...base,
      version: 1,
      description: 'A small CNN trained off the unit (seedypod/training) that names each pod empty, sprouted, growing, ready or unhealthy.',
      disabled,
      run: () => ({ results: [] }),
    }
  }
  const f = model.file
  return {
    ...base,
    version: f.version,
    description: `A small CNN trained off the unit (seedypod/training) that names each pod ${f.classes.join(', ')}. Revision ${f.revision}${f.notes ? `: ${f.notes}` : '.'}`,
    run: (img, pods) => ({ results: classifyPods(model, img, pods) }),
  }
}

/** Parse and check a pod-state weights file. Throws ModelError naming the problem. */
export function parsePodStateModel(text: string): CnnModel {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (e) {
    throw new ModelError(`not JSON: ${(e as Error).message}`)
  }
  const model = parseModel(raw)
  if (model.file.analyzer !== POD_STATE_ID) throw new ModelError(`the weights file is for ${model.file.analyzer}, not ${POD_STATE_ID}`)
  // Results store the class index, so every revision must keep the same classes in the same order.
  if (model.file.classes.join() !== POD_STATES.join()) throw new ModelError(`the weights file's classes must be ${POD_STATES.join(', ')}`)
  return model
}

/** Parse a weights file's text into an analyser; a bad file gives a disabled one naming the problem. */
export function podStateFromText(text: string | null, missing: string = NO_WEIGHTS, as: RunsAs = SHIPPED): CaptureAnalyzer {
  if (text === null) return podStateAnalyzer(null, missing, as)
  try {
    return podStateAnalyzer(parsePodStateModel(text), NO_WEIGHTS, as)
  }
  catch (e) {
    return podStateAnalyzer(null, `The weights file could not be loaded: ${(e as Error).message}.`, as)
  }
}

/**
 * A learned analyser as it crosses to the vision worker: the weights file's
 * text, and what it runs as. `path` is where the file is on disk, for
 * podvision (#191); it is absent where there is no file (tests, the demo).
 */
export interface LearnedSpec { id: string, label: string, text: string | null, missing?: string, path?: string }

export function learnedAnalyzers(specs: LearnedSpec[]): CaptureAnalyzer[] {
  return specs.map(s => podStateFromText(s.text, s.missing, { id: s.id, label: s.label }))
}
