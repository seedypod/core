import { encode } from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { analyzeCapture, decodeJpeg, podTrends } from '../analyze'

function jpeg(width: number, height: number, greenLeftHalf: boolean) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const green = greenLeftHalf && x < width / 2
      data[i] = green ? 60 : 20
      data[i + 1] = green ? 180 : 20
      data[i + 2] = green ? 70 : 25
      data[i + 3] = 255
    }
  }
  return new Uint8Array(encode({ data, width, height }, 90).data)
}

describe('vision analyze', () => {
  it('decodes JPEGs and rejects other bytes', () => {
    expect(decodeJpeg(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(decodeJpeg(jpeg(60, 40, false))?.width).toBe(60)
  })

  it('scores pods per capture and reports trends', () => {
    const store = new MemoryStore()
    const bytes = jpeg(300, 250, true)
    for (let i = 0; i < 12; i++) {
      analyzeCapture(store, { id: `c${i}`, camera: 'upper', ts: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, path: '', bytes: bytes.byteLength }, bytes)
    }
    const trends = podTrends(store, 15)
    expect(trends).toHaveLength(15)
    // left column (slots 1, 4, 7, …) is green, right column is not
    expect(trends[0]?.green).toBeGreaterThan(0.5)
    expect(trends[2]?.green).toBeLessThan(0.1)
    expect(trends[0]?.verdict).toBe('stalled')
    expect(store.podGrowth.series(1)).toHaveLength(12)
  })
})
