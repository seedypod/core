import { decode } from 'jpeg-js'
import type { Capture, Store } from '../store/types'
import { defaultPodRects, greenFraction, growthTrend, type Rgba } from './greenArea'

/** Decode a JPEG into RGBA; returns null for anything that isn't a JPEG (demo SVGs, stubs). */
export function decodeJpeg(bytes: Uint8Array): Rgba | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null
  try {
    const d = decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 })
    return { width: d.width, height: d.height, data: d.data }
  }
  catch {
    return null
  }
}

/** Score every pod visible in a capture and persist the points. */
export function analyzeCapture(store: Store, capture: Capture, bytes: Uint8Array): number {
  const img = decodeJpeg(bytes)
  if (!img) return 0
  const rects = defaultPodRects(capture.camera, img.width, img.height)
  const points = Object.entries(rects).map(([slot, rect]) => ({ ts: capture.ts, slot: Number(slot), green: Math.round(greenFraction(img, rect) * 1000) / 1000, captureId: capture.id }))
  store.podGrowth.add(points)
  return points.length
}

export interface PodTrend { slot: number, green: number | null, verdict: 'growing' | 'stalled' | 'declining' | 'unknown', slope: number, samples: number }

export function podTrends(store: Store, slots = 30): PodTrend[] {
  const out: PodTrend[] = []
  for (let slot = 1; slot <= slots; slot++) {
    const series = store.podGrowth.series(slot, 48)
    const t = growthTrend(series)
    out.push({ slot, green: series.at(-1)?.green ?? null, verdict: t.verdict, slope: Math.round(t.slope * 1000) / 1000, samples: series.length })
  }
  return out
}
