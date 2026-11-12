/**
 * A small convolutional network in plain TypeScript (#185): the forward pass of
 * a model trained off the unit (seedypod/training) and shipped as a weights file.
 *
 * The Pi Zero W has no runtime for ONNX (ADR 0019, 2026-11-09 amendment), and a
 * net this size runs in well under a second per pod in plain JavaScript. This
 * module is the whole boundary: a parsed weights file and a Float32Array input
 * in, logits out. It does no cropping, normalising or I/O, so a native backend
 * could replace it without touching the analyser.
 *
 * Activations are height × width × channels (HWC). A conv3x3 weight is stored
 * [out][ky][kx][in], so the inner loop reads one pixel's channels in a row; a
 * dense weight is [out][in], as PyTorch's Linear stores it.
 */

export const MODEL_FORMAT = 'seedypod-cnn'
export const MODEL_FORMAT_VERSION = 1

/** A 3×3 convolution with stride 1 and zero padding 1, then ReLU. */
export interface Conv3x3Layer { type: 'conv3x3', in: number, out: number, weight: string, bias: string }
/** 2×2 max pool with stride 2; an odd last row or column is dropped, as PyTorch does. */
export interface MaxPoolLayer { type: 'maxpool2' }
/** Mean over height and width, leaving one value per channel. */
export interface GapLayer { type: 'gap' }
/** Fully connected; the last layer, its outputs are the logits. */
export interface DenseLayer { type: 'dense', in: number, out: number, weight: string, bias: string }
export type Layer = Conv3x3Layer | MaxPoolLayer | GapLayer | DenseLayer

export interface ModelInput {
  width: number
  height: number
  channels: number
  layout: 'HWC'
  /** Pixel values are divided by this (255) before the per-channel mean and std. */
  scale: number
  mean: number[]
  std: number[]
}

export interface TensorFile { shape: number[], dtype: 'float32', /** Little-endian float32, base64. */ data: string }

/** The weights file as stored: a JSON header with the tensors inline. */
export interface ModelFile {
  format: typeof MODEL_FORMAT
  formatVersion: number
  /** The analyser it is for, e.g. `pod-state`. */
  analyzer: string
  /** Results are stored under this analyser version; a retrained model gets a new one. */
  version: number
  /** Human name of this training run, e.g. `bootstrap-2026-11`. */
  revision: string
  classes: string[]
  input: ModelInput
  layers: Layer[]
  tensors: Record<string, TensorFile>
  /** Stills darker than this (mean of R, G and B, 0–1) are skipped: the model never saw the light off. */
  minBrightness?: number
  trainedAt?: string
  notes?: string
  training?: Record<string, unknown>
}

interface CompiledConv { type: 'conv3x3', in: number, out: number, w: Float32Array, b: Float32Array }
interface CompiledDense { type: 'dense', in: number, out: number, w: Float32Array, b: Float32Array }
type Compiled = CompiledConv | MaxPoolLayer | GapLayer | CompiledDense

/** A parsed, shape-checked model, ready to run. */
export interface CnnModel {
  file: Omit<ModelFile, 'tensors'>
  layers: Compiled[]
  params: number
  /** Two activation buffers, sized for the largest layer and reused on every call. */
  scratch: [Float32Array, Float32Array]
}

export class ModelError extends Error {}

function decodeFloat32(t: TensorFile, name: string): Float32Array {
  if (t?.dtype !== 'float32' || !Array.isArray(t.shape) || typeof t.data !== 'string') throw new ModelError(`tensor ${name} must be float32 with a shape and base64 data`)
  const bin = atob(t.data)
  const n = t.shape.reduce((a, b) => a * b, 1)
  if (bin.length !== n * 4) throw new ModelError(`tensor ${name} has ${bin.length / 4} values, its shape says ${n}`)
  const view = new DataView(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

function tensor(file: ModelFile, name: string, shape: number[]): Float32Array {
  const t = file.tensors[name]
  if (!t) throw new ModelError(`tensor ${name} is missing`)
  if (t.shape.join('×') !== shape.join('×')) throw new ModelError(`tensor ${name} is ${t.shape.join('×')}, expected ${shape.join('×')}`)
  return decodeFloat32(t, name)
}

/** Validate a weights file and decode its tensors. Throws ModelError with what is wrong. */
export function parseModel(raw: unknown): CnnModel {
  const file = raw as ModelFile
  if (!file || typeof file !== 'object' || file.format !== MODEL_FORMAT) throw new ModelError(`not a ${MODEL_FORMAT} weights file`)
  if (file.formatVersion !== MODEL_FORMAT_VERSION) throw new ModelError(`format version ${file.formatVersion} is not supported (expected ${MODEL_FORMAT_VERSION})`)
  if (!Number.isInteger(file.version) || file.version < 1) throw new ModelError('version must be a positive integer')
  if (!Array.isArray(file.classes) || file.classes.length < 2) throw new ModelError('classes must list at least two names')
  const inp = file.input
  if (!inp || inp.layout !== 'HWC' || !(inp.width > 0) || !(inp.height > 0) || !(inp.channels > 0) || !(inp.scale > 0)) throw new ModelError('input must give width, height, channels, scale and layout HWC')
  if (inp.mean?.length !== inp.channels || inp.std?.length !== inp.channels || inp.std.some(s => !(s > 0))) throw new ModelError('input mean and std need one positive value per channel')
  if (!Array.isArray(file.layers) || file.layers.length === 0) throw new ModelError('layers is empty')

  let [h, w, c] = [inp.height, inp.width, inp.channels]
  let flat = false
  let biggest = h * w * c
  let params = 0
  const layers: Compiled[] = file.layers.map((l, i) => {
    const at = `layer ${i} (${l?.type})`
    if (flat !== (l?.type === 'dense')) throw new ModelError(l?.type === 'dense' ? `${at} needs a gap layer before it` : `${at} follows a flattening layer`)
    switch (l?.type) {
      case 'conv3x3': {
        if (l.in !== c) throw new ModelError(`${at} takes ${l.in} channels, gets ${c}`)
        const cw = tensor(file, l.weight, [l.out, 3, 3, l.in])
        const cb = tensor(file, l.bias, [l.out])
        params += cw.length + cb.length
        c = l.out
        biggest = Math.max(biggest, h * w * c)
        return { type: 'conv3x3', in: l.in, out: l.out, w: cw, b: cb }
      }
      case 'maxpool2':
        if (h < 2 || w < 2) throw new ModelError(`${at} on a ${h}×${w} map`)
        h = Math.floor(h / 2)
        w = Math.floor(w / 2)
        return { type: 'maxpool2' }
      case 'gap':
        flat = true
        h = 1
        w = 1
        return { type: 'gap' }
      case 'dense': {
        if (l.in !== h * w * c) throw new ModelError(`${at} takes ${l.in} inputs, gets ${h * w * c}`)
        const dw = tensor(file, l.weight, [l.out, l.in])
        const db = tensor(file, l.bias, [l.out])
        params += dw.length + db.length
        flat = true
        h = 1
        w = 1
        c = l.out
        return { type: 'dense', in: l.in, out: l.out, w: dw, b: db }
      }
      default:
        throw new ModelError(`${at} is not a known layer type`)
    }
  })
  if (layers.at(-1)?.type !== 'dense' || c !== file.classes.length) throw new ModelError(`the last layer must be dense with one output per class (${file.classes.length})`)
  const header: Partial<ModelFile> = { ...file }
  delete header.tensors
  return { file: header as Omit<ModelFile, 'tensors'>, layers, params, scratch: [new Float32Array(biggest), new Float32Array(biggest)] }
}

/** conv3x3 + ReLU, HWC, zero padding. */
function conv3x3(src: Float32Array, H: number, W: number, C: number, l: CompiledConv, dst: Float32Array): void {
  const K = l.out
  const { w, b } = l
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * K
      for (let k = 0; k < K; k++) {
        let s = b[k] as number
        let wi = k * 9 * C
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) {
            wi += 3 * C
            continue
          }
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) {
              wi += C
              continue
            }
            const base = (yy * W + xx) * C
            for (let ch = 0; ch < C; ch++) s += (src[base + ch] as number) * (w[wi++] as number)
          }
        }
        dst[o + k] = s > 0 ? s : 0
      }
    }
  }
}

function maxPool2(src: Float32Array, H: number, W: number, C: number, dst: Float32Array): void {
  const h = Math.floor(H / 2)
  const w = Math.floor(W / 2)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (2 * y * W + 2 * x) * C
      const o = (y * w + x) * C
      for (let c = 0; c < C; c++) {
        const a = i + c
        dst[o + c] = Math.max(src[a] as number, src[a + C] as number, src[a + W * C] as number, src[a + W * C + C] as number)
      }
    }
  }
}

/**
 * Run the network on one input of `input.height × input.width × input.channels`
 * values (already normalised). Returns the logits, one per class.
 */
export function forward(model: CnnModel, input: Float32Array): Float32Array {
  const { input: inp } = model.file
  let [H, W, C] = [inp.height, inp.width, inp.channels]
  if (input.length !== H * W * C) throw new ModelError(`input has ${input.length} values, the model takes ${H * W * C}`)
  let [a, b] = model.scratch
  a.set(input)
  for (const l of model.layers) {
    if (l.type === 'conv3x3') {
      conv3x3(a, H, W, C, l, b)
      C = l.out
    }
    else if (l.type === 'maxpool2') {
      maxPool2(a, H, W, C, b)
      H = Math.floor(H / 2)
      W = Math.floor(W / 2)
    }
    else if (l.type === 'gap') {
      const n = H * W
      for (let c = 0; c < C; c++) {
        let s = 0
        for (let p = 0; p < n; p++) s += a[p * C + c] as number
        b[c] = s / n
      }
      H = 1
      W = 1
    }
    else {
      const n = l.in
      for (let j = 0; j < l.out; j++) {
        let s = l.b[j] as number
        const row = j * n
        for (let i = 0; i < n; i++) s += (a[i] as number) * (l.w[row + i] as number)
        b[j] = s
      }
      H = 1
      W = 1
      C = l.out
    }
    ;[a, b] = [b, a]
  }
  return a.slice(0, C)
}

export function softmax(logits: Float32Array): Float32Array {
  const max = Math.max(...logits)
  const e = logits.map(v => Math.exp(v - max))
  const sum = e.reduce((s, v) => s + v, 0)
  return e.map(v => v / sum)
}
