import { describe, expect, it } from 'vitest'
import { cameraOf, cameraSlots, clampRegion, DEFAULT_REGIONS, podRegions, REF, REFERENCE_CUPS, toPixels, type Camera } from '../regions'

const inside = (x: number, y: number, r: { x: number, y: number, w: number, h: number }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

describe('pod regions (#143)', () => {
  it('numbers each camera\'s pods across then down', () => {
    expect(cameraSlots('upper')).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    expect(cameraSlots('lower')).toEqual(Array.from({ length: 15 }, (_, i) => i + 16))
    expect([cameraOf(1), cameraOf(15), cameraOf(16), cameraOf(30), cameraOf(0), cameraOf(31)]).toEqual(['upper', 'upper', 'lower', 'lower', null, null])
  })

  it('puts each cup on the reference stills inside its own box, and in no other box\'s middle', () => {
    for (const camera of ['upper', 'lower'] as Camera[]) {
      const boxes = DEFAULT_REGIONS[camera]
      expect(Object.keys(boxes).map(Number)).toEqual(cameraSlots(camera))
      REFERENCE_CUPS[camera].forEach(([px, py], i) => {
        const slot = cameraSlots(camera)[i] as number
        const [x, y] = [px / REF.width, py / REF.height]
        const own = boxes[slot]
        if (!own) throw new Error(`no box for ${slot}`)
        // Slot 28's cup is below the lower frame; its box sits at the edge, clamped up.
        if (slot !== 28) expect(inside(x, y, own), `${camera} pod ${slot}`).toBe(true)
        expect(inside(x, y, { x: own.x + own.w / 3, y: own.y + own.h / 3, w: own.w / 3, h: own.h / 3 }) || slot === 28).toBe(true)
        for (const [other, r] of Object.entries(boxes)) {
          if (Number(other) === slot) continue
          expect(inside(x, y, { x: r.x + r.w / 3, y: r.y + r.h / 3, w: r.w / 3, h: r.h / 3 }), `${camera} pod ${slot} in ${other}'s middle`).toBe(false)
        }
      })
      for (const r of Object.values(boxes)) {
        expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.00001 && r.y + r.h <= 1.00001).toBe(true)
      }
    }
  })

  it('takes the owner\'s boxes where they moved one and the defaults elsewhere', () => {
    const moved = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    const upper = podRegions('upper', { upper: { 4: moved } })
    expect(upper[4]).toEqual(moved)
    expect(upper[5]).toEqual(DEFAULT_REGIONS.upper[5])
    expect(podRegions('lower', { upper: { 4: moved } })).toEqual(DEFAULT_REGIONS.lower)
    expect(podRegions('lower', null)).toEqual(DEFAULT_REGIONS.lower)
  })

  it('keeps boxes inside the frame and scales them to pixels', () => {
    expect(clampRegion({ x: -0.2, y: 0.95, w: 0.3, h: 0.1 })).toEqual({ x: 0, y: 0.9, w: 0.3, h: 0.1 })
    expect(clampRegion({ x: 0.5, y: 0.5, w: 0, h: 2 })).toEqual({ x: 0.5, y: 0, w: 0.01, h: 1 })
    expect(toPixels({ 3: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 } }, 1280, 960)).toEqual({ 3: { x: 320, y: 480, w: 640, h: 240 } })
  })
})
