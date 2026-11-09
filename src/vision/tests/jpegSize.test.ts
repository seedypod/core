import { describe, expect, it } from 'vitest'
import { bounds } from '../greenArea'
import { jpegSize } from '../jpegSize'
import { cropPixels, DEFAULT_REGIONS, toPixels } from '../regions'
import { jpeg } from './fixtures'

describe('jpegSize', () => {
  it('reads width and height from the frame header', () => {
    expect(jpegSize(jpeg(80, 60, true))).toEqual({ width: 80, height: 60 })
    expect(jpegSize(jpeg(1280, 960, false))).toEqual({ width: 1280, height: 960 })
  })

  it('skips fill bytes and markers without a length', () => {
    const j = jpeg(32, 16, false)
    const padded = new Uint8Array([0xFF, 0xD8, 0xFF, 0xFF, 0xD0, 0xFF, 0x01, ...j.slice(2)])
    expect(jpegSize(padded)).toEqual({ width: 32, height: 16 })
  })

  it('returns null for anything that is not a sized JPEG', () => {
    expect(jpegSize(new TextEncoder().encode('<svg/>'))).toBeNull()
    expect(jpegSize(new Uint8Array([0xFF, 0xD8]))).toBeNull()
    // Scan data before any frame header, a byte that isn't a marker, a zero-length segment, a header cut short, a zero size.
    expect(jpegSize(new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0, 0]))).toBeNull()
    expect(jpegSize(new Uint8Array([0xFF, 0xD8, 0x00, 0x00, 0x00, 0x00]))).toBeNull()
    expect(jpegSize(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00, 0, 0]))).toBeNull()
    expect(jpegSize(new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 8, 0]))).toBeNull()
    expect(jpegSize(new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 8, 0, 0, 0, 0, 0]))).toBeNull()
  })
})

describe('cropPixels', () => {
  it('is the whole-pixel window the analysers read for a box', () => {
    for (const [slot, r] of Object.entries(toPixels(DEFAULT_REGIONS.upper, 1280, 960))) {
      const b = bounds(r, 1280, 960)
      expect(cropPixels(DEFAULT_REGIONS.upper[Number(slot)] as typeof r, 1280, 960)).toEqual({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 })
    }
    expect(cropPixels({ x: 0.1, y: 0.25, w: 0.5, h: 0.5 }, 101, 40)).toEqual({ x: 10, y: 10, w: 51, h: 20 })
    expect(cropPixels({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, 100, 100)).toEqual({ x: 90, y: 90, w: 10, h: 10 })
  })
})
