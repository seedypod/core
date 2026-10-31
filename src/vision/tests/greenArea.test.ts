import { describe, expect, it } from 'vitest'
import { defaultPodRects, greenFraction, growthTrend, isGreen } from '../greenArea'

function img(width: number, height: number, paint: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

describe('green area', () => {
  it('classifies leafy greens vs dark background and white LED glare', () => {
    expect(isGreen(60, 180, 70)).toBe(true)
    expect(isGreen(20, 20, 25)).toBe(false)
    expect(isGreen(240, 240, 240)).toBe(false)
  })

  it('measures the green fraction of a crop', () => {
    const im = img(100, 100, x => (x < 50 ? [60, 180, 70] : [20, 20, 25]))
    expect(greenFraction(im, { x: 0, y: 0, w: 100, h: 100 })).toBeCloseTo(0.5, 2)
    expect(greenFraction(im, { x: 50, y: 0, w: 50, h: 100 })).toBe(0)
    expect(greenFraction(im, { x: 200, y: 200, w: 10, h: 10 })).toBe(0)
  })

  it('lays out 15 pods per camera', () => {
    const upper = defaultPodRects('upper', 1280, 720)
    const lower = defaultPodRects('lower', 1280, 720)
    expect(Object.keys(upper).map(Number)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    expect(Object.keys(lower).map(Number)[0]).toBe(16)
    expect(upper[1]?.w).toBeGreaterThan(0)
  })

  it('reports growth trend over windows', () => {
    const series = Array.from({ length: 12 }, (_, i) => ({ ts: `t${i}`, slot: 1, green: 0.1 + i * 0.01 }))
    expect(growthTrend(series).verdict).toBe('growing')
    const flat = series.map(p => ({ ...p, green: 0.3 }))
    expect(growthTrend(flat).verdict).toBe('stalled')
    expect(growthTrend(series.slice(0, 5)).verdict).toBe('unknown')
    const dying = series.map((p, i) => ({ ...p, green: 0.5 - i * 0.01 }))
    expect(growthTrend(dying).verdict).toBe('declining')
  })
})
