import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

/** Reads a gzip'd ustar into name → bytes (tests only; the restore helper has the real reader). */
export function untar(gz: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(gz)
  const out = new Map<string, Uint8Array>()
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512)
    if (h.every(b => b === 0)) break
    const name = new TextDecoder().decode(h.subarray(0, 100)).replace(/\0.*$/s, '')
    const size = Number.parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0.*$/s, '').trim(), 8)
    out.set(name, new Uint8Array(tar.subarray(at + 512, at + 512 + size)))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
