/**
 * A JPEG's width and height from its frame header, without decoding it. The
 * dataset export uses it to turn pod boxes into pixel crops (#184), and a Pi
 * can't afford a full decode per labelled still just for that.
 */
export function jpegSize(bytes: Uint8Array): { width: number, height: number } | null {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null
  let i = 2
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xFF) return null
    const marker = bytes[i + 1] as number
    // Fill bytes before a marker, and markers that carry no length.
    if (marker === 0xFF) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2
      continue
    }
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number)
    // Start-of-frame markers: C0–CF except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (i + 8 >= bytes.length) return null
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number)
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (marker === 0xD9 || marker === 0xDA || length < 2) return null
    i += 2 + length
  }
  return null
}
