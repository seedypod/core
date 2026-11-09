#!/usr/bin/env node
// Reference off-device analyser (ADR-0019). Pulls recent stills from a unit,
// scores each pod, and posts the results back under its own analyser id, so
// they appear on the unit's Analysis screen next to the on-device analysers.
//
// Swap `score` for anything: a PlantCV pipeline, an ONNX model, a GPU job.
//
// Usage:
//   SEEDYPOD_URL=http://seedypod.local SEEDYPOD_INGEST_TOKEN=… \
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

/**
 * Each pod's box on each camera, as fractions of the frame: the unit's own
 * (measured on the cups, or calibrated on its Analysis screen), so the worker
 * scores the same part of the still as the unit does.
 */
const regions = Object.fromEntries((await (await fetch(`${base}/api/vision/regions`, { headers: readHeaders })).json()).map(c => [c.camera, c.regions]))
function podRects(camera, width, height) {
  return Object.fromEntries((regions[camera] ?? []).map(r => [r.slot, { x: r.x * width, y: r.y * height, w: r.w * width, h: r.h * height }]))
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
