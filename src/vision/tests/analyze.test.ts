import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import type { AnalysisRow } from '../../store/types'
import { decodeJpeg, podTrends } from '../analyze'
import { jpeg } from './fixtures'

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
