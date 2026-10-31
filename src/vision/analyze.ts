import { decode } from 'jpeg-js'
import type { Store } from '../store/types'
import { growthTrend, type Rgba } from './greenArea'

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

export interface PodTrend { slot: number, green: number | null, verdict: 'growing' | 'stalled' | 'declining' | 'unknown', slope: number, samples: number }

/** Growth verdict per pod from one analyser's green fraction (the primary one unless named). */
export function podTrends(store: Store, slots = 30, analyzer = store.settings.get().primaryAnalyzer): PodTrend[] {
  const out: PodTrend[] = []
  for (let slot = 1; slot <= slots; slot++) {
    const series = store.analyses.series({ analyzer, slot, metric: 'green_fraction', limit: 48 }).map(p => ({ ts: p.ts, slot, green: p.value }))
    const t = growthTrend(series)
    out.push({ slot, green: series.at(-1)?.green ?? null, verdict: t.verdict, slope: Math.round(t.slope * 1000) / 1000, samples: series.length })
  }
  return out
}
