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

/** Rows to skip between the ones checked. */
const ROW_STRIDE = 4
/** Checked rows of it that make a frame damaged: more than a stray coincidence. */
const FILLED_ROWS = 2

/** The colour a zeroed YUV buffer decodes to, (0, 135, 0), allowing for JPEG's rounding. */
const isZeroFill = (r: number, g: number, b: number) => r <= 16 && b <= 16 && g >= 119 && g <= 151

/**
 * Whether full-width rows of a still are the solid green of a zero-filled YUV
 * frame. A frame cut short leaves its tail zeroed, `fswebcam` encodes that as a
 * valid JPEG, and it scores as leaf cover on an empty pod. No scene fills whole
 * rows with that exact colour. hald refuses these now, but stills it took
 * before it could are still on the card and can be re-scored. Every pixel of a
 * row has to match, since a thin stripe makes it a real scene; a normal row
 * stops at its first pixel, so this costs almost nothing.
 */
export function hasZeroFilledRows(img: Rgba): boolean {
  let filled = 0
  for (let y = 0; y < img.height; y += ROW_STRIDE) {
    let all = true
    for (let x = 0; x < img.width && all; x++) {
      const i = (y * img.width + x) * 4
      all = isZeroFill(img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0)
    }
    if (all && ++filled >= FILLED_ROWS) return true
  }
  return false
}

export interface PodTrend {
  slot: number
  green: number | null
  verdict: 'growing' | 'stalled' | 'declining' | 'unknown'
  slope: number
  samples: number
  /** The last dozen measurements, oldest first, for a sparkline. */
  recent: number[]
}

/** Growth verdict per pod from one analyser's green fraction (the primary one unless named). */
export function podTrends(store: Store, slots = 30, analyzer = store.settings.get().primaryAnalyzer): PodTrend[] {
  const out: PodTrend[] = []
  for (let slot = 1; slot <= slots; slot++) {
    const series = store.analyses.series({ analyzer, slot, metric: 'green_fraction', limit: 48 }).map(p => ({ ts: p.ts, slot, green: p.value }))
    const t = growthTrend(series)
    out.push({ slot, green: series.at(-1)?.green ?? null, verdict: t.verdict, slope: Math.round(t.slope * 1000) / 1000, samples: series.length, recent: series.slice(-12).map(p => Math.round(p.green * 1000) / 1000) })
  }
  return out
}
