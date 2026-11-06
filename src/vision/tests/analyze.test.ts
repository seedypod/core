import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import type { AnalysisRow } from '../../store/types'
import { encode } from 'jpeg-js'
import { decodeJpeg, hasZeroFilledRows, podTrends } from '../analyze'
import { execute } from '../execute'
import { jpeg } from './fixtures'

/** A grey still whose rows from `from` down are one colour, through a real JPEG round trip. */
function filled(from: number, colour: [number, number, number], width = 320, height = 240, stripeAt?: number) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const stripe = stripeAt !== undefined && x >= stripeAt && x < stripeAt + 3
      const px = stripe ? [200, 200, 200] : y >= from ? colour : [90 + (x % 7), 95, 88 + (y % 5)]
      data.set([...px, 255] as number[], i)
    }
  }
  return new Uint8Array(encode({ data, width, height }, 85).data)
}

const GREEN: [number, number, number] = [0, 135, 0]

describe('hasZeroFilledRows', () => {
  const check = (bytes: Uint8Array) => {
    const img = decodeJpeg(bytes)
    if (!img) throw new Error('should decode')
    return hasZeroFilledRows(img)
  }

  it('finds the green of a frame cut short', () => {
    expect(check(filled(144, GREEN))).toBe(true)
    expect(check(filled(232, GREEN))).toBe(true)
  })

  it('leaves whole frames alone, even leaf-green ones', () => {
    expect(check(filled(240, GREEN))).toBe(false)
    expect(check(jpeg(320, 240, true))).toBe(false)
    expect(check(jpeg(320, 240, false))).toBe(false)
    // Dark frames, blown-out frames, and full-width leaf green that isn't the exact colour.
    expect(check(filled(0, [0, 0, 0]))).toBe(false)
    expect(check(filled(0, [255, 255, 255]))).toBe(false)
    expect(check(filled(0, [60, 180, 70]))).toBe(false)
  })

  it('sees a thin stripe of real picture anywhere across the row', () => {
    // Between the columns a sampling check would look at (5, 15, 25...).
    expect(check(filled(0, GREEN, 320, 240, 9))).toBe(false)
    expect(check(filled(0, GREEN, 320, 240, 310))).toBe(false)
  })

  it('needs more than a stray row', () => {
    expect(check(filled(236, GREEN, 320, 240))).toBe(false)
  })

  it('keeps a damaged frame out of the analysers', () => {
    const job = { camera: 'upper' as const, analyzers: ['green-threshold'], opts: { artifacts: false } }
    expect(execute({ ...job, bytes: filled(144, GREEN) })).toBe('damaged')
    expect(execute({ ...job, bytes: filled(240, GREEN) })).toEqual(expect.any(Array))
    expect(execute({ ...job, bytes: new Uint8Array([1, 2, 3]) })).toBeNull()
  })
})

describe('vision analyze', () => {
  it('decodes JPEGs and rejects other bytes', () => {
    expect(decodeJpeg(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(decodeJpeg(new Uint8Array([0xFF, 0xD8, 0, 0, 1]))).toBeNull()
    expect(decodeJpeg(jpeg(60, 40, false))?.width).toBe(60)
  })

  it('reports per-pod trends from the primary analyser, or the one asked for', () => {
    const store = new MemoryStore()
    const rows: AnalysisRow[] = []
    for (let i = 0; i < 12; i++) {
      const base = { captureId: `c${i}`, ts: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, camera: 'upper' as const, version: 1, source: 'device' as const, metric: 'green_fraction', detail: null, artifact: null }
      rows.push({ ...base, analyzer: 'green-threshold', slot: 1, value: 0.6 })
      rows.push({ ...base, analyzer: 'exg-otsu', slot: 1, value: 0.1 + i * 0.05 })
    }
    store.analyses.add(rows)
    const primary = podTrends(store, 15)
    expect(primary).toHaveLength(15)
    expect(primary[0]).toMatchObject({ slot: 1, green: 0.6, verdict: 'stalled', samples: 12 })
    expect(primary[1]).toMatchObject({ green: null, verdict: 'unknown', samples: 0 })
    expect(podTrends(store, 1, 'exg-otsu')[0]?.verdict).toBe('growing')
    store.settings.update({ primaryAnalyzer: 'exg-otsu' })
    expect(podTrends(store, 1)[0]?.verdict).toBe('growing')
  })
})
