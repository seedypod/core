#!/usr/bin/env node
// Refreshes the timezone → coordinates table that light curves following the
// sun fall back on until the owner sets the unit's location. Each zone's
// coordinates are its principal city's, from the tz database's zone.tab
// (public domain). Browsers still list a few zones by their old names, so
// those are added as aliases of the new ones.
//
//   node scripts/sync-zone-coords.mjs                         # /usr/share/zoneinfo/zone.tab
//   node scripts/sync-zone-coords.mjs <tzdata>/zone.tab
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('../src/scheduler/zoneCoords.json', import.meta.url))
const source = process.argv[2] ?? '/usr/share/zoneinfo/zone.tab'

/** Old names Intl still uses → the zone.tab name. */
const ALIASES = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
}

/** ISO 6709 ±DDMM[SS] or ±DDDMM[SS] to decimal degrees, to two places (about a kilometre). */
function degrees(s, degDigits) {
  const sign = s[0] === '-' ? -1 : 1
  const d = Number(s.slice(1, 1 + degDigits))
  const m = Number(s.slice(1 + degDigits, 3 + degDigits))
  const sec = Number(s.slice(3 + degDigits) || 0)
  return Math.round(sign * (d + m / 60 + sec / 3600) * 100) / 100
}

const zones = {}
for (const line of readFileSync(source, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  const [, coords, zone] = line.split('\t')
  const m = /^([+-]\d+)([+-]\d+)$/.exec(coords ?? '')
  if (!m || !zone) continue
  const [lat, lon] = [m[1], m[2]]
  zones[zone] = [degrees(lat, 2), degrees(lon, 3)]
}
for (const [old, now] of Object.entries(ALIASES)) {
  if (!zones[now]) throw new Error(`${now} (for ${old}) isn't in ${source}`)
  zones[old] = zones[now]
}
const missing = Intl.supportedValuesOf('timeZone').filter(z => z !== 'UTC' && !z.startsWith('Etc/') && !zones[z])
if (missing.length) console.warn(`no coordinates for: ${missing.join(' ')}`)
const sorted = Object.fromEntries(Object.keys(zones).sort().map(z => [z, zones[z]]))
writeFileSync(out, `${JSON.stringify(sorted)}\n`)
console.log(`wrote ${Object.keys(sorted).length} zones to ${out}`)
