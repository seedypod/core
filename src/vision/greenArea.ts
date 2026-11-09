/**
 * Classical plant-vision (Phase 7.2): fraction of "green" pixels per pod crop,
 * tracked over time. No model, no training data — a transparent baseline that
 * answers "is anything growing in slot 12?" and "did slot 9 stop growing?"
 * before anything learned is justified. Works on raw RGBA buffers so it runs
 * in Node (sharp/jpeg-js) or the browser (canvas) identically.
 */

export interface Rgba { width: number, height: number, data: Uint8ClampedArray | Uint8Array }
export interface Rect { x: number, y: number, w: number, h: number }

/** Excess-green index threshold, a standard vegetation heuristic: 2G − R − B. */
export function isGreen(r: number, g: number, b: number, threshold = 20): boolean {
  return 2 * g - r - b > threshold && g > 40
}

/**
 * Whether a pixel has a leaf's colour rather than a colour cast's. Excess green
 * alone also fires on the white tower under a warm or green-tinted light
 * (208, 208, 176 scores 32), on a grey-green wall and on dark olive shadow, which
 * read as 30–60 % cover on empty pods in the reference stills. A leaf has green
 * as its strongest channel, a hue from yellow-green (75°) to blue-green (170°),
 * real saturation, and enough light to tell.
 */
export function isLeafColour(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const span = max - Math.min(r, g, b)
  if (g < max || max < 70 || span < 0.35 * max) return false
  // With green the largest channel, hue = 60° × ((b − r) / span + 2).
  const h = (b - r) / span
  return h >= -0.75 && h <= 5 / 6
}

/** Pixel bounds of `rect`, clamped to the image. */
function bounds(rect: Rect, width: number, height: number) {
  return {
    x0: Math.max(0, Math.floor(rect.x)),
    y0: Math.max(0, Math.floor(rect.y)),
    x1: Math.min(width, Math.ceil(rect.x + rect.w)),
    y1: Math.min(height, Math.ceil(rect.y + rect.h)),
  }
}

/** A blob of plant pixels smaller than this share of the frame is sensor noise, not a seedling. */
const MIN_BLOB = 1 / 40_000

/**
 * Leaf cover per pod from a plant mask (non-zero = plant). A pod counts a
 * connected blob of plant pixels inside its region only when the blob grows
 * from that pod: its centre lies in the region (else nearest the region's
 * centre), or it reaches the region's core, the middle third each way where the
 * cup is. So the leaves of a large plant that spill over the edge of an empty
 * neighbour's region don't read as cover there, while a tower of plants whose
 * leaves have grown together still counts for every pod they grow from. Specks
 * too small to be a seedling count for no one.
 */
export function coverByPod(mask: Uint8Array, width: number, height: number, pods: Record<number, Rect>): Record<number, number> {
  const n = width * height
  const label = new Int32Array(n)
  const stack = new Int32Array(n)
  // Per blob (1-based): pixel count and coordinate sums for its centre.
  const size = [0]
  const sumX = [0]
  const sumY = [0]
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start]) continue
    const id = size.length
    let count = 0
    let sx = 0
    let sy = 0
    let top = 0
    stack[top++] = start
    label[start] = id
    while (top > 0) {
      const p = stack[--top] as number
      const x = p % width
      const y = (p - x) / width
      count++
      sx += x
      sy += y
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && mask[q] && !label[q]) {
          label[q] = id
          stack[top++] = q
        }
      }
    }
    size.push(count)
    sumX.push(sx)
    sumY.push(sy)
  }

  const slots = Object.entries(pods).map(([slot, rect]) => ({ slot: Number(slot), rect }))
  const minBlob = Math.max(2, Math.round(n * MIN_BLOB))
  const owner = size.map((count, id) => {
    if (id === 0) return 0
    const cx = (sumX[id] as number) / count
    const cy = (sumY[id] as number) / count
    const inside = slots.find(({ rect }) => cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h)
    if (inside) return inside.slot
    let best = 0
    let bestD = Infinity
    for (const { slot, rect } of slots) {
      const d = (rect.x + rect.w / 2 - cx) ** 2 + (rect.y + rect.h / 2 - cy) ** 2
      if (d < bestD) {
        bestD = d
        best = slot
      }
    }
    return best
  })

  const big = (id: number) => id > 0 && (size[id] as number) >= minBlob
  const out: Record<number, number> = {}
  for (const { slot, rect } of slots) {
    const rooted = new Set<number>()
    const core = bounds({ x: rect.x + rect.w / 3, y: rect.y + rect.h / 3, w: rect.w / 3, h: rect.h / 3 }, width, height)
    for (let y = core.y0; y < core.y1; y++) {
      for (let x = core.x0; x < core.x1; x++) rooted.add(label[y * width + x] as number)
    }
    const { x0, y0, x1, y1 } = bounds(rect, width, height)
    let own = 0
    let total = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const id = label[y * width + x] as number
        if (big(id) && (owner[id] === slot || rooted.has(id))) own++
        total++
      }
    }
    out[slot] = total === 0 ? 0 : own / total
  }
  return out
}

/**
 * Static crop map: Gardyn cameras are fixed and pods sit in three columns of
 * ten; the upper camera sees slots 1–15, the lower 16–30. Calibrate the grid
 * per unit in settings (Phase 6); these defaults are a sane starting layout.
 */
export function defaultPodRects(camera: 'upper' | 'lower', width: number, height: number): Record<number, Rect> {
  const cols = 3
  const rows = 5
  const start = camera === 'upper' ? 1 : 16
  const out: Record<number, Rect> = {}
  const cw = width / cols
  const rh = height / rows
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const slot = start + r * cols + c
      out[slot] = { x: c * cw + cw * 0.1, y: r * rh + rh * 0.1, w: cw * 0.8, h: rh * 0.8 }
    }
  }
  return out
}

export interface GrowthPoint { ts: string, slot: number, green: number }

/**
 * Growth verdict from a per-slot series (oldest → newest): compares the mean
 * of the last `window` points against the previous window.
 */
export function growthTrend(series: GrowthPoint[], window = 6): { slope: number, verdict: 'growing' | 'stalled' | 'declining' | 'unknown' } {
  if (series.length < window * 2) return { slope: 0, verdict: 'unknown' }
  const recent = series.slice(-window)
  const prior = series.slice(-window * 2, -window)
  const mean = (p: GrowthPoint[]) => p.reduce((s, x) => s + x.green, 0) / p.length
  const slope = mean(recent) - mean(prior)
  if (slope > 0.01) return { slope, verdict: 'growing' }
  if (slope < -0.02) return { slope, verdict: 'declining' }
  return { slope, verdict: 'stalled' }
}
