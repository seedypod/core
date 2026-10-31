#!/usr/bin/env node
// Reference off-device analyser (ADR-0019). Pulls recent stills from a unit,
// scores each pod, and posts the results back under its own analyser id, so
// they appear on the unit's Analysis screen next to the on-device analysers.
//
// Swap `score` for anything: a PlantCV pipeline, an ONNX model, a GPU job.
//
// Usage:
//   SEEDYPOD_URL=http://seedypod.local:3000 SEEDYPOD_INGEST_TOKEN=… \
//   [SEEDYPOD_API_KEY=…] node scripts/analysis-worker.mjs [--limit 48] [--id exg-strict] [--version 1]
import { decode } from 'jpeg-js'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const base = (process.env.SEEDYPOD_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const token = process.env.SEEDYPOD_INGEST_TOKEN
const apiKey = process.env.SEEDYPOD_API_KEY
const analyzer = args.id ?? 'exg-strict'
const version = Number(args.version ?? 1)
const limit = Number(args.limit ?? 48)
if (!token) {
  console.error('SEEDYPOD_INGEST_TOKEN is required (Settings → Off-device storage and analysis → Generate)')
  process.exit(2)
}
const readHeaders = apiKey ? { 'x-api-key': apiKey } : {}

/** Pods 1–15 on the upper camera, 16–30 on the lower, in a 3 × 5 grid (matches the unit's default crop). */
function podRects(camera, width, height) {
  const out = {}
  const cw = width / 3
  const rh = height / 5
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) out[(camera === 'upper' ? 1 : 16) + r * 3 + c] = { x: c * cw + cw * 0.1, y: r * rh + rh * 0.1, w: cw * 0.8, h: rh * 0.8 }
  }
  return out
}

/** A stricter excess-green cut than the unit's fixed threshold: a second opinion to compare against. */
function score(img, rect) {
  let green = 0
  let total = 0
  for (let y = Math.floor(rect.y); y < Math.min(img.height, rect.y + rect.h); y++) {
    for (let x = Math.floor(rect.x); x < Math.min(img.width, rect.x + rect.w); x++) {
      const i = (y * img.width + x) * 4
      if (2 * img.data[i + 1] - img.data[i] - img.data[i + 2] > 40) green++
      total++
    }
  }
  return total ? Math.round((green / total) * 1000) / 1000 : 0
}

const captures = await (await fetch(`${base}/api/captures?limit=${limit}`, { headers: readHeaders })).json()
const results = []
for (const c of captures) {
  const r = await fetch(`${base}${c.url}`, { headers: readHeaders })
  if (!r.ok || r.headers.get('content-type') !== 'image/jpeg') continue
  let img
  try {
    img = decode(new Uint8Array(await r.arrayBuffer()), { useTArray: true })
  }
  catch {
    continue
  }
  for (const [slot, rect] of Object.entries(podRects(c.camera, img.width, img.height))) {
    results.push({ captureId: c.id, slot: Number(slot), metric: 'green_fraction', value: score(img, rect), ts: c.ts, camera: c.camera })
  }
}
if (results.length === 0) {
  console.log('no JPEG stills to score')
  process.exit(0)
}
const posted = await fetch(`${base}/api/analyses/results`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
  body: JSON.stringify({ analyzer, version, results }),
})
const body = await posted.json()
if (!posted.ok) {
  console.error(`ingest refused (${posted.status}): ${body.error}`)
  process.exit(1)
}
console.log(`${analyzer}@${version}: stored ${body.stored} results from ${captures.length} captures${body.skipped.length ? `, skipped ${body.skipped.length}` : ''}`)
