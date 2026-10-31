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
