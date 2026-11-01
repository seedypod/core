/**
 * Demo seed — a believable Gardyn mid-cycle: a light curve, two pump cycles,
 * a 19-day-old grow with 24 planted pods, a week of telemetry, and a few
 * camera frames (SVGs standing in for JPEGs). Deterministic so the demo looks
 * the same every load.
 */
import type { HalClient } from '../hardware/types'
import type { AnalysisRow, Store, TelemetryPoint } from '../store/types'

const PLANTS = ['Butterhead Lettuce', 'Genovese Basil', 'Arugula', 'Red Russian Kale', 'Cherry Tomato', 'Thai Basil', 'Mint', 'Swiss Chard', 'Bok Choy', 'Jalapeño', 'Cilantro', 'Dill']

export function seedDemo(store: Store, hal: HalClient, now = new Date()): void {
  const day = 86_400_000
  const started = new Date(now.getTime() - 19 * day)
  store.settings.update({ unitName: 'Kitchen Gardyn', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', captureIntervalMin: 60, setupComplete: true })

  store.schedules.upsert({ id: 'daylight', kind: 'light', name: 'Daylight curve', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 0 }, { minute: 450, level: 85 }, { minute: 1140, level: 85 }, { minute: 1260, level: 0 }] } })
  store.schedules.upsert({ id: 'morning-water', kind: 'pump', name: 'Morning watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })
  store.schedules.upsert({ id: 'evening-water', kind: 'pump', name: 'Evening watering', enabled: true, days: 127, spec: { minute: 1200, durationS: 300 } })
  store.schedules.upsert({ id: 'weekend-boost', kind: 'light', name: 'Weekend boost', enabled: false, days: 0b1100000, spec: { setpoints: [{ minute: 600, level: 100 }, { minute: 900, level: 100 }, { minute: 960, level: 0 }] } })

  const cycle = store.grow.start(started.toISOString(), 'Autumn greens + herbs')
  store.grow.setStage('vegetative', now.toISOString())
  store.grow.markIssued('reminder_thinning')
  store.grow.markIssued('reminder_nutrients:1')
  store.grow.markIssued('reminder_nutrients:2')
  void cycle

  for (let slot = 1; slot <= 30; slot++) {
    if (slot > 24) continue
    const plant = PLANTS[(slot * 7) % PLANTS.length] ?? 'Lettuce'
    const status = slot === 9 ? 'attention' : slot <= 6 ? 'harvest' : 'growing'
    store.pods.update(slot, { plant, plantedAt: started.toISOString().slice(0, 10), status, notes: slot === 9 ? 'Yellowing lower leaves — check nutrients' : '' }, now.toISOString())
  }

  // Harvest windows for some of the crops, as an agent would fill them in (ADR-0022); the rest lean on the camera.
  const profile = (name: string, harvestMinDays: number, harvestMaxDays: number, targetCover: number) => store.plants.upsert({ name, harvestMinDays, harvestMaxDays, targetCover, notes: '', source: 'agent' }, now.toISOString())
  profile('Arugula', 17, 25, 0.4)
  profile('Basil', 25, 35, 0.35)
  profile('Kale', 30, 45, 0.45)
  profile('Bok Choy', 30, 40, 0.45)
  profile('Cilantro', 21, 30, 0.3)

  // A week of telemetry at 15-min resolution with a daily rhythm.
  const pts: TelemetryPoint[] = []
  for (let m = 7 * 1440; m >= 0; m -= 15) {
    const ts = new Date(now.getTime() - m * 60_000)
    const h = ts.getHours() + ts.getMinutes() / 60
    const lightOn = h >= 7 && h < 21
    const phase = Math.sin(((h - 6) / 24) * Math.PI * 2)
    pts.push({ ts: ts.toISOString(), sensor: 'air_temp', value: round(22 + 2.2 * phase + (lightOn ? 0.8 : -0.4)) })
    pts.push({ ts: ts.toISOString(), sensor: 'humidity', value: round(50 - 6 * phase + (lightOn ? 3 : 0)) })
    pts.push({ ts: ts.toISOString(), sensor: 'pcb_temp', value: round(29 + (lightOn ? 4 : 0) + 0.5 * phase) })
    const refillDay = Math.floor(m / 1440)
    pts.push({ ts: ts.toISOString(), sensor: 'water_level_pct', value: round(92 - ((7 * 1440 - m) % (3 * 1440)) / (3 * 1440) * 45 + refillDay * 0) })
    pts.push({ ts: ts.toISOString(), sensor: 'pump_w', value: (ts.getHours() === 8 || ts.getHours() === 20) && ts.getMinutes() < 5 ? 3.1 : 0 })
  }
  store.telemetry.add(pts)
  store.counters.add('light_hours', 19 * 14 + 2130, now.toISOString())

  store.alerts.raise('reminder_nutrients', 'Add nutrients (every 7 days)', new Date(now.getTime() - 2 * 3_600_000).toISOString())

  // Camera frames: generated SVG "stills" so the gallery has something to show.
  for (const cam of ['upper', 'lower'] as const) {
    for (let i = 5; i >= 0; i--) {
      const ts = new Date(now.getTime() - i * 6 * 3_600_000)
      const id = `${cam}-${ts.toISOString().replace(/[:.]/g, '-')}`
      store.captures.add({ id, camera: cam, ts: ts.toISOString(), path: `data:image/svg+xml;utf8,${encodeURIComponent(frameSvg(cam, 19 - i / 4))}`, bytes: 4096 })
      store.analyses.add(demoAnalyses(id, cam, ts.toISOString(), 19 - i / 4))
    }
  }

  // Autopilot (ADR-0020): one armed notify, one armed light policy, one dose rule still in dry-run.
  const ts = now.toISOString()
  const lit = (value: number) => ({ kind: 'literal' as const, value })
  const sensor = (id: string) => ({ kind: 'signal' as const, signal: `sensor.${id}` })
  store.automations.create({ name: 'Tank getting low', enabled: true, dryRun: false, priority: 50, cooldownMin: 240, trigger: { kind: 'tick', everyMin: 15 }, conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '<', left: sensor('water_level_pct'), right: lit(30) }] }, actions: [{ kind: 'notify', message: 'top up the tank' }] }, ts)
  store.automations.create({ name: 'Dim when hot', enabled: true, dryRun: false, priority: 60, cooldownMin: null, trigger: { kind: 'tick', everyMin: 5 }, conditions: { kind: 'sustained', forMin: 10, condition: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'sensor.air_temp', lastMin: 15 }, right: lit(29) }] } }, actions: [{ kind: 'setLight', level: lit(60) }] }, ts)
  store.automations.create({ name: 'pH drifting up', enabled: true, dryRun: true, priority: 50, cooldownMin: 360, trigger: { kind: 'tick', everyMin: 10 }, conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'sensor.ph', lastMin: 60 }, right: lit(6.5) }] }, actions: [{ kind: 'dose', doser: 'dose_1', durationS: lit(5) }] }, ts)

  // Put the sim in a state that matches the story.
  void hal.setActuator('light', { on: true, level: 85 })
}

/**
 * `SEED_DEMO=1` on the server: the same story in a real database, so the
 * simulator has history to test against (backups, restores, charts). Only a
 * database nobody has set up is seeded, so a restart never doubles it.
 */
export function seedIfFresh(store: Store, hal: HalClient, now = new Date()): boolean {
  if (store.settings.get().setupComplete || store.grow.current()) return false
  seedDemo(store, hal, now)
  return true
}

function frameSvg(camera: 'upper' | 'lower', dayAge: number): string {
  const g = Math.min(1, dayAge / 30)
  const leaves = Array.from({ length: 6 }, (_, i) => {
    const x = 60 + i * 110
    const r = 18 + g * 28 + ((i * 7) % 5)
    return `<ellipse cx="${x}" cy="${camera === 'upper' ? 150 : 190}" rx="${r}" ry="${r * 0.7}" fill="#50c878" opacity="0.9"/><ellipse cx="${x + 10}" cy="${camera === 'upper' ? 135 : 175}" rx="${r * 0.8}" ry="${r * 0.5}" fill="#6fd68f" opacity="0.8"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 300"><rect width="720" height="300" fill="#141414"/><rect y="220" width="720" height="80" fill="#1d1d1f"/>${leaves}<text x="12" y="290" font-family="monospace" font-size="14" fill="#8b8b92">${camera} · demo frame</text></svg>`
}

/**
 * Both on-device analysers' view of a demo frame. The SVG stills can't be
 * decoded, so the scores follow the same growth curve the frames draw, with
 * Otsu reading slightly higher on lush pods, as it does on real stills.
 */
function demoAnalyses(captureId: string, camera: 'upper' | 'lower', ts: string, dayAge: number): AnalysisRow[] {
  const g = Math.min(1, dayAge / 30)
  const first = camera === 'upper' ? 1 : 16
  return Array.from({ length: 15 }, (_, k) => first + k).flatMap((slot) => {
    const vigour = 0.55 + ((slot * 37) % 10) / 20
    const base = Math.min(0.95, g * vigour * 0.9)
    const row = { captureId, ts, camera, version: 1, source: 'device' as const, slot, metric: 'green_fraction', artifact: null }
    return [
      { ...row, analyzer: 'green-threshold', value: Math.round(base * 1000) / 1000, detail: null },
      { ...row, analyzer: 'exg-otsu', value: Math.round(Math.min(0.97, base * 1.08 + 0.01) * 1000) / 1000, detail: { threshold: 141 } },
    ]
  })
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
