#!/usr/bin/env node
// Writes a gzipped copy next to each compressible file of the web build, for
// core to send as it is (`precompressed` in server/app.ts). A unit's one 1 GHz
// core can't afford to compress per request, and over Wi-Fi the bytes matter.
//
// Gzip, not Brotli: the unit serves plain http://, and browsers only offer
// `br` over https, so a `.br` copy would never go out.
//
//   node scripts/precompress.mjs web/dist
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Fonts and images are compressed already.
const COMPRESSIBLE = /\.(?:css|html|js|json|svg|txt)$/
/** Below this a response fits a packet or two either way. */
const MIN_BYTES = 1024

const dir = process.argv[2]
if (!dir) {
  console.error('usage: precompress.mjs <dir>')
  process.exit(1)
}

let before = 0
let after = 0
for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue
  const file = join(entry.parentPath, entry.name)
  const raw = readFileSync(file)
  if (raw.length < MIN_BYTES) continue
  const gz = gzipSync(raw, { level: 9 })
  if (gz.length >= raw.length) continue
  writeFileSync(`${file}.gz`, gz)
  before += raw.length
  after += gz.length
}
console.log(`precompress: ${before} B -> ${after} B gzipped`)
