import { describe, expect, it } from 'vitest'
import type { Reading, SensorId } from '../../hardware/contract'
import type { HalSnapshot } from '../../hardware/types'
import { MemoryStore } from '../../store/memory'
import type { TankActionKind } from '../../store/types'
import { CHORE_IDS, chores, cropGroup, tankDropPerDay, trusted, type Chore, type ChoreId } from '../chores'
import { CITE } from '../knowledge'

const NOW = new Date('2026-11-09T12:00:00Z')
const DAY = 86_400_000
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString()
const read = (value: number, unit: string, quality: Reading['quality'] = 'good', ts = NOW.toISOString()): Reading => ({ ts, value, unit, quality })
const ALL: SensorId[] = ['water_level_pct', 'water_distance', 'ec', 'ph', 'air_temp']

function snap(sensors: Partial<Record<SensorId, Reading>>, o: { caps?: SensorId[], online?: boolean } = {}): HalSnapshot {
  return {
    online: o.online ?? true,
    system: { contract: 1, unitId: 'u', model: 'gardyn', halVersion: 'test', caps: { sensors: o.caps ?? ALL, actuators: ['light', 'pump'], cameras: ['upper', 'lower'] }, limits: { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 } },
    sensors, actuators: {}, alerts: {}, devices: null,
  }
}

function garden(plants: Array<[string, number]> = [['Arugula', 10]], status: 'seeded' | 'growing' = 'growing') {
  const store = new MemoryStore()
  plants.forEach(([plant, plantedDaysAgo], i) => store.pods.update(i + 1, { plant, status, plantedAt: ago(plantedDaysAgo) }, ago(plantedDaysAgo)))
  return store
}
const log = (store: MemoryStore, kind: TankActionKind, daysAgo: number) => store.tankActions.add({ ts: ago(daysAgo), kind, amount: null, unit: null, product: null, note: '', source: 'user' }, ago(daysAgo))
const one = (store: MemoryStore, s: HalSnapshot, id: ChoreId): Chore => chores(store, s, NOW).find(c => c.id === id) as Chore
/** Tank readings every 2 h for `days`, falling `perDay` points from `start`. */
function tankSeries(store: MemoryStore, start: number, perDay: number, days = 2) {
  const pts = Array.from({ length: days * 12 + 1 }, (_, i) => ({ ts: new Date(NOW.getTime() - (days * 12 - i) * 2 * 3_600_000).toISOString(), sensor: 'water_level_pct' as const, value: start - (perDay * i) / 12 }))
  store.telemetry.add(pts)
}

describe('trusted readings', () => {
  it('uses a good, fresh reading and says why it won\'t use any other', () => {
    expect(trusted(snap({ ec: read(1.4, 'mS/cm') }), 'ec', NOW)).toMatchObject({ why: null, reading: { value: 1.4 } })
    expect(trusted(snap({ ec: read(1.4, 'mS/cm', 'suspect') }), 'ec', NOW).why).toBe('EC reading suspect')
    expect(trusted(snap({ ec: read(1.4, 'mS/cm', 'stale') }), 'ec', NOW).why).toBe('EC reading stale')
    expect(trusted(snap({ ec: read(1.4, 'mS/cm', 'good', ago(1 / 48)) }), 'ec', NOW).why).toBe('EC reading stale')
    expect(trusted(snap({}), 'ec', NOW).why).toBe('EC not reporting')
    expect(trusted(snap({}, { caps: ['air_temp'] }), 'ec', NOW).why).toBe('no EC probe')
    expect(trusted(snap({}, { caps: ['air_temp'] }), 'water_level_pct', NOW).why).toBe('no tank level sensor')
    expect(trusted(snap({}, { caps: ['air_temp'] }), 'pump_w', NOW).why).toBe('no pump_w probe')
    expect(trusted(snap({ ph: read(6, 'pH') }, { online: false }), 'ph', NOW).why).toBe('pH unknown while the hardware daemon is offline')
  })
})

describe('top off', () => {
  it('is due from a trusted tank level below half, with how fast it falls, citing the note', () => {
    const store = garden()
    tankSeries(store, 56, 8)
    const c = one(store, snap({ water_level_pct: read(40, '%') }), 'top_off')
    expect(c).toMatchObject({ state: 'due', basis: 'reading', dueAt: NOW.toISOString(), citations: [CITE.tankHalfFull], doneKind: 'top_off' })
    expect(c.reason).toBe('Tank at 40%, falling 8% a day: below half, so top it off. Keep it at least half full.')
    expect(c.readings).toEqual([{ sensor: 'water_level_pct', value: 40, unit: '%', quality: 'good', ts: NOW.toISOString() }])
  })

  it('is soon when the fall will take it below half within 2 days, and ok otherwise', () => {
    const store = garden()
    tankSeries(store, 76, 8)
    const soon = one(store, snap({ water_level_pct: read(60, '%') }), 'top_off')
    expect(soon).toMatchObject({ state: 'soon', dueAt: new Date(NOW.getTime() + 1.25 * DAY).toISOString(), reason: 'Tank at 60%, falling 8% a day: below half in about 1.3 d.' })
    const ok = one(store, snap({ water_level_pct: read(90, '%') }), 'top_off')
    expect(ok).toMatchObject({ state: 'ok', reason: 'Tank at 90%, falling 8% a day: half full in about 5 d.' })
    expect(one(garden(), snap({ water_level_pct: read(90, '%') }), 'top_off')).toMatchObject({ state: 'ok', dueAt: null, reason: 'Tank at 90%.' })
  })

  it('never advises a top-off from a suspect level: it falls back to the calendar and says why', () => {
    const store = garden()
    log(store, 'top_off', 2)
    const c = one(store, snap({ water_level_pct: read(12, '%', 'suspect') }), 'top_off')
    expect(c).toMatchObject({ state: 'ok', basis: 'timeline', readings: [], citations: [CITE.tankCadence], lastDoneAt: ago(2) })
    expect(c.reason).toBe('Calendar guess, tank level reading suspect: 2 d since the last top-off. Gardyn tops off every 7 d.')
    expect(c.reason).not.toContain('12')
    log(store, 'refresh', 8)
    const store2 = garden()
    log(store2, 'refresh', 8)
    expect(one(store2, snap({ water_level_pct: read(12, '%', 'suspect') }), 'top_off')).toMatchObject({ state: 'due', basis: 'timeline', dueAt: ago(1), reason: expect.stringContaining('8 d since the last refresh') })
  })

  it('falls back the same way on a stale, missing or absent level, or with hald offline', () => {
    const store = garden()
    expect(one(store, snap({ water_level_pct: read(30, '%', 'good', ago(1)) }), 'top_off').reason).toMatch(/^Calendar guess, tank level reading stale: 10 d since the first pod was planted/)
    expect(one(store, snap({}), 'top_off').reason).toMatch(/^Calendar guess, tank level not reporting/)
    expect(one(store, snap({}, { caps: ['air_temp'] }), 'top_off').reason).toMatch(/^Calendar guess, no tank level sensor/)
    expect(one(store, snap({ water_level_pct: read(30, '%') }, { online: false }), 'top_off')).toMatchObject({ basis: 'timeline', state: 'due' })
  })

  it('waits for the reading to settle right after a logged top-off', () => {
    const store = garden()
    log(store, 'top_off', 10 / 1440)
    expect(one(store, snap({ water_level_pct: read(40, '%') }), 'top_off')).toMatchObject({ state: 'ok', basis: 'reading', dueAt: null, reason: 'Tank at 40%, but a top-off was logged 10 min ago: waiting for the reading to settle.' })
    const later = garden()
    log(later, 'top_off', 2 / 24)
    expect(one(later, snap({ water_level_pct: read(40, '%') }), 'top_off').state).toBe('due')
  })
})

describe('tank drop rate', () => {
  it('fits the fall since the last top-up, and needs half a day of readings', () => {
    const store = new MemoryStore()
    tankSeries(store, 90, 6)
    expect(tankDropPerDay(store, NOW)).toBe(6)
    // A top-up starts a new segment.
    store.telemetry.add([{ ts: ago(0.1), sensor: 'water_level_pct', value: 99 }, { ts: ago(0.05), sensor: 'water_level_pct', value: 98.9 }])
    expect(tankDropPerDay(store, NOW)).toBeNull()
    const rising = new MemoryStore()
    tankSeries(rising, 40, -3)
    expect(tankDropPerDay(rising, NOW)).toBe(0)
    expect(tankDropPerDay(new MemoryStore(), NOW)).toBeNull()
  })
})

describe('feed', () => {
  it('is due from a trusted EC below the crop target, and says to dose to the reading', () => {
    const store = garden([['Arugula', 20], ['Buttercrunch', 20]])
    const c = one(store, snap({ ec: read(0.94, 'mS/cm') }), 'feed')
    expect(c).toMatchObject({ state: 'due', basis: 'reading', citations: [CITE.phEc, CITE.dosesByProduct] })
    expect(c.reason).toBe('EC 0.9 mS/cm, below the 1.2–2.0 mS/cm for leafy greens: feed until it reads about 1.2. Dose to the reading; teaspoons differ between products.')
  })

  it('holds off above the target, warns at its low end, and is ok inside it', () => {
    const store = garden()
    expect(one(store, snap({ ec: read(2.4, 'mS/cm') }), 'feed')).toMatchObject({ state: 'ok', reason: expect.stringContaining('don\'t feed. Topping off with plain water brings it down.') })
    expect(one(store, snap({ ec: read(1.25, 'mS/cm') }), 'feed')).toMatchObject({ state: 'soon', reason: expect.stringContaining('at the low end') })
    expect(one(store, snap({ ec: read(1.5, 'mS/cm') }), 'feed')).toMatchObject({ state: 'ok', reason: 'EC 1.5 mS/cm, within the 1.2–2.0 mS/cm for leafy greens.' })
  })

  it('waits after a logged feed for the EC to mix', () => {
    const store = garden()
    log(store, 'feed', 5 / 1440)
    expect(one(store, snap({ ec: read(0.9, 'mS/cm') }), 'feed')).toMatchObject({ state: 'ok', reason: 'EC 0.9 mS/cm, below the 1.2–2.0 mS/cm for leafy greens, but a feed was logged 5 min ago: waiting for the reading to settle.' })
  })

  it('without an EC probe, guesses from the calendar: the sprout dose first, then weekly', () => {
    const store = garden([['Arugula', 10]])
    const first = one(store, snap({}, { caps: ['water_level_pct'] }), 'feed')
    expect(first).toMatchObject({ state: 'ok', basis: 'timeline', dueAt: ago(-4), citations: [CITE.plantFood, CITE.dosesByProduct] })
    expect(first.reason).toBe('Calendar guess, no EC probe: 10 d since the first pod was planted. The first feed, Gardyn\'s sprout dose of 1/4 tsp Gardyn Plant Food per gallon, goes in once most yCubes have sprouted, usually within 14 d.')
    log(store, 'feed', 8)
    const weekly = one(store, snap({ ec: read(0.5, 'mS/cm', 'suspect') }), 'feed')
    expect(weekly).toMatchObject({ state: 'due', basis: 'timeline', lastDoneAt: ago(8) })
    expect(weekly.reason).toMatch(/^Calendar guess, EC reading suspect: 8 d since the last feed\. Gardyn adds plant food with the weekly top-off: 1\/2 tsp per gallon/)
    store.settings.update({ nutrientReminderDays: 10 })
    expect(one(store, snap({}), 'feed').state).toBe('soon')
  })
})

describe('crop group', () => {
  it('feeds seedlings early in a cycle, then what most of the tower is', () => {
    const fruiting = garden([['Banana Pepper', 30], ['Black Pearl Pepper', 30], ['Basil', 30]])
    expect(cropGroup(fruiting, fruiting.pods.list().filter(p => p.status !== 'empty'))).toEqual({ group: 'fruiting crops', fruiting: 2 })
    const herbs = garden([['Basil', 30], ['Chervil', 30], ['Something Unlisted', 30]])
    expect(cropGroup(herbs, herbs.pods.list().filter(p => p.status !== 'empty')).group).toBe('herbs')
    herbs.grow.start(ago(3))
    expect(cropGroup(herbs, herbs.pods.list().filter(p => p.status !== 'empty')).group).toBe('seedlings')
    expect(one(herbs, snap({ ec: read(1, 'mS/cm') }), 'feed').reason).toBe('EC 1 mS/cm, within the 0.8–1.2 mS/cm for seedlings.')
    const none = garden([['Something Unlisted', 3]])
    expect(cropGroup(none, none.pods.list().filter(p => p.status !== 'empty')).group).toBe('leafy greens')
  })
})

describe('refresh, clean and roots', () => {
  it('refreshes every 28 days, or 14 with four or more fruiting plants', () => {
    const store = garden()
    store.grow.start(ago(29))
    expect(one(store, snap({}), 'refresh')).toMatchObject({ state: 'due', basis: 'timeline', citations: [CITE.tankCadence], reason: 'Calendar, as no reading measures it: 29 d since the grow cycle started. Gardyn refreshes at least every 28 d, and sooner on yellowing leaves or leaf-edge burn.' })
    const peppers = garden([['Banana Pepper', 13], ['Black Pearl Pepper', 13], ['Burrito Pepper', 13], ['Bare Root Strawberries', 13]])
    expect(one(peppers, snap({}), 'refresh')).toMatchObject({ state: 'soon', reason: expect.stringContaining('every 14 d with 4 or more fruiting plants (4 here)') })
  })

  it('says when there is nothing to count from', () => {
    const store = new MemoryStore()
    store.pods.update(1, { plant: 'Kale', status: 'growing' }, ago(1))
    expect(one(store, snap({}), 'refresh')).toMatchObject({ state: 'unknown', dueAt: null, reason: 'Calendar, as no reading measures it: nothing logged or planted to count from.' })
  })

  it('suggests a deep clean every third refresh, saying the interval is a guess', () => {
    const store = garden()
    log(store, 'clean', 85)
    expect(one(store, snap({}), 'clean')).toMatchObject({ state: 'due', lastDoneAt: ago(85), reason: 'Calendar guess, as Gardyn publishes no cleaning interval: 85 d since the last clean. seedypod suggests a deep clean every third refresh (84 d).' })
  })

  it('checks roots on the grow-reminder interval, with no citation since no number is dosed', () => {
    const store = garden([['Kale', 22]])
    expect(one(store, snap({}), 'trim_roots')).toMatchObject({ state: 'due', basis: 'timeline', citations: [], reason: 'Calendar guess, as no sensor sees the roots: 22 d since the first pod was planted. Check them every 21 d (Settings → Grow reminders) and trim any reaching the pump.' })
    log(store, 'trim_roots', 1)
    expect(one(store, snap({}), 'trim_roots').state).toBe('ok')
    store.settings.update({ rootCheckReminderDays: 0 })
    expect(one(store, snap({}), 'trim_roots')).toMatchObject({ state: 'ok', reason: 'Root checks are off in Settings → Grow reminders.' })
  })
})

describe('thin', () => {
  function photographed(covers: number[], photoDaysAgo = 0.2) {
    const store = garden(covers.map(() => ['Arugula', 9] as [string, number]), 'seeded')
    store.analyses.add(covers.map((value, i) => ({ captureId: `c${i}`, ts: ago(photoDaysAgo), camera: 'upper' as const, analyzer: 'green-threshold', version: 2, source: 'device' as const, slot: i + 1, metric: 'green_fraction', value, detail: null, artifact: null })))
    return store
  }

  it('is due from the camera once most young pods show leaves', () => {
    const c = one(photographed([0.05, 0.03, 0.04, 0.01]), snap({}), 'thin')
    expect(c).toMatchObject({ state: 'due', basis: 'reading', citations: [CITE.plantFood], reason: '3 of 4 young pods show leaves on camera, so most have sprouted: thin each pod to its strongest sprout.' })
  })

  it('is soon with a few up, and ok with none yet', () => {
    expect(one(photographed([0.05, 0, 0, 0]), snap({}), 'thin')).toMatchObject({ state: 'soon', reason: '1 of 4 young pods show leaves on camera; thin once most have sprouted.' })
    expect(one(photographed([0, 0.01]), snap({}), 'thin')).toMatchObject({ state: 'ok', basis: 'reading', reason: 'No leaves on camera yet in 2 young pods.' })
  })

  it('falls back to the calendar without recent photos of most young pods', () => {
    const old = one(photographed([0.05, 0.05], 3), snap({}), 'thin')
    expect(old).toMatchObject({ state: 'ok', basis: 'timeline', reason: 'Calendar guess, no recent photos of the young pods: 9 d since the oldest young pod was planted. yCubes usually sprout within 14 d; thin about 14 d after planting.' })
    const store = photographed([0.05])
    store.pods.update(2, { plant: 'Kale', status: 'seeded', plantedAt: ago(13) }, ago(13))
    store.pods.update(3, { plant: 'Kale', status: 'seeded', plantedAt: ago(13) }, ago(13))
    expect(one(store, snap({}), 'thin')).toMatchObject({ state: 'soon', basis: 'timeline', reason: expect.stringMatching(/^Calendar guess, too few recent photos of the young pods: 13 d/) })
  })

  it('is done once thinning is logged after the youngest planting, and has nothing to do with no young pods', () => {
    const store = photographed([0.05, 0.05])
    log(store, 'thin', 1)
    expect(one(store, snap({}), 'thin')).toMatchObject({ state: 'ok', reason: 'Thinned since the youngest pods were planted.' })
    expect(one(garden([['Kale', 60]]), snap({}), 'thin')).toMatchObject({ state: 'ok', reason: 'No pods planted in the last 35 d to thin.' })
  })
})

describe('chores', () => {
  it('lists every chore in a fixed order, each marked done by its own tank action', () => {
    const list = chores(garden(), snap({}), NOW)
    expect(list.map(c => c.id)).toEqual([...CHORE_IDS])
    expect(list.map(c => c.doneKind)).toEqual(['thin', 'trim_roots', 'top_off', 'refresh', 'feed', 'clean'])
  })

  it('asks nothing of an empty tower but a clean', () => {
    const store = new MemoryStore()
    store.grow.start(ago(100))
    const list = chores(store, snap({ water_level_pct: read(10, '%'), ec: read(0.1, 'mS/cm') }), NOW)
    expect(list.filter(c => c.id !== 'clean').every(c => c.state === 'ok' && c.reason === 'Nothing planted.')).toBe(true)
    expect(list.find(c => c.id === 'clean')?.state).toBe('due')
  })
})
