import { describe, expect, it } from 'vitest'
import { coverByPod, defaultPodRects, growthTrend, isGreen, isLeafColour } from '../greenArea'

describe('green area', () => {
  it('classifies leafy greens vs dark background and white LED glare', () => {
    expect(isGreen(60, 180, 70)).toBe(true)
    expect(isGreen(20, 20, 25)).toBe(false)
    expect(isGreen(240, 240, 240)).toBe(false)
  })

  it('tells a leaf from a colour cast that excess green alone calls green', () => {
    // Leaves under white, warm and dim light.
    for (const [r, g, b] of [[60, 180, 70], [140, 190, 60], [150, 200, 110], [40, 100, 40]] as const) expect(isLeafColour(r, g, b)).toBe(true)
    // Sampled from the empty tower on the reference stills (#132): the warm-lit PVC,
    // the grey-green wall and dark olive shadow all clear 2G − R − B > 20.
    for (const [r, g, b] of [[208, 208, 176], [192, 192, 160], [112, 128, 96], [48, 64, 32]] as const) {
      expect(isGreen(r, g, b)).toBe(true)
      expect(isLeafColour(r, g, b)).toBe(false)
    }
    // Yellow, cyan, grey, and too dark to tell.
    expect(isLeafColour(200, 200, 40)).toBe(false)
    expect(isLeafColour(40, 200, 200)).toBe(false)
    expect(isLeafColour(128, 128, 128)).toBe(false)
    expect(isLeafColour(20, 60, 20)).toBe(false)
  })

  it('gives each blob of plant to the pod it grows from', () => {
    const w = 30
    const h = 10
    const mask = new Uint8Array(w * h)
    const paint = (x0: number, x1: number, y0: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = 1
    }
    const pods = { 1: { x: 0, y: 0, w: 10, h: 10 }, 2: { x: 10, y: 0, w: 10, h: 10 }, 3: { x: 20, y: 0, w: 10, h: 10 } }
    // A plant centred in pod 1 whose leaves reach into pod 2 short of its core, and a stray speck in pod 3.
    paint(0, 13, 0, 10)
    mask[25 + 5 * w] = 1
    const cover = coverByPod(mask, w, h, pods)
    expect(cover[1]).toBe(1)
    expect(cover[2]).toBe(0)
    expect(cover[3]).toBe(0)
    // A blob centred between regions goes to the nearest pod; a region off the frame reads 0.
    expect(coverByPod(mask, w, h, { 2: { x: 10, y: 0, w: 10, h: 10 }, 9: { x: 100, y: 100, w: 5, h: 5 } })).toEqual({ 2: 0.3, 9: 0 })
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
