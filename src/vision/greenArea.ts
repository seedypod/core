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

/** Fraction of green pixels inside `rect` (clamped to the image). */
export function greenFraction(img: Rgba, rect: Rect, threshold?: number): number {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w))
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.h))
  let green = 0
  let total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      const r = img.data[i] ?? 0
      const g = img.data[i + 1] ?? 0
      const b = img.data[i + 2] ?? 0
      if (isGreen(r, g, b, threshold)) green++
      total++
    }
  }
  return total === 0 ? 0 : green / total
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
