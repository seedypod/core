import { encode } from 'jpeg-js'

/** A JPEG whose left half is leaf-green (when asked) over dark soil. */
export function jpeg(width: number, height: number, greenLeftHalf: boolean, opts: { tint?: [number, number, number] } = {}) {
  const [tr, tg, tb] = opts.tint ?? [0, 0, 0]
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const green = greenLeftHalf && x < width / 2
      data[i] = (green ? 60 : 20) + tr
      data[i + 1] = (green ? 180 : 20) + tg
      data[i + 2] = (green ? 70 : 25) + tb
      data[i + 3] = 255
    }
  }
  return new Uint8Array(encode({ data, width, height }, 90).data)
}

/** Colours sampled from the empty tower on the reference stills (#132): warm-lit PVC, its shade, the grey-green wall, dark olive shadow. */
export const CAST: Array<[number, number, number]> = [[208, 208, 176], [192, 192, 160], [112, 128, 96], [48, 64, 32]]

export interface Disc { x: number, y: number, r: number, ry?: number, colour?: [number, number, number] }

/**
 * A still of an empty tower under a tinted light, in bands of the cast
 * colours, with leaf-green ellipses painted on as plants.
 */
export function tower(width: number, height: number, plants: Disc[]) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const plant = plants.find(d => ((x - d.x) / d.r) ** 2 + ((y - d.y) / (d.ry ?? d.r)) ** 2 <= 1)
      const px = plant ? plant.colour ?? [60, 170, 70] : CAST[Math.floor(x / 37 + y / 23) % CAST.length] as [number, number, number]
      data.set([...px, 255], (y * width + x) * 4)
    }
  }
  return new Uint8Array(encode({ data, width, height }, 85).data)
}

/** The 3 × 5 grid the analysers used before the boxes were measured on the cups, for fixtures drawn on it. */
export function grid(camera: 'upper' | 'lower'): Record<number, { x: number, y: number, w: number, h: number }> {
  const first = camera === 'upper' ? 1 : 16
  const out: Record<number, { x: number, y: number, w: number, h: number }> = {}
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) out[first + r * 3 + c] = { x: (c + 0.1) / 3, y: (r + 0.1) / 5, w: 0.8 / 3, h: 0.8 / 5 }
  }
  return out
}
