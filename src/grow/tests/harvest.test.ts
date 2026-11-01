import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import type { PlantProfile, Pod } from '../../store/types'
import { DEFAULT_TARGET_COVER, harvestOutlook, matchProfile, outlookFor } from '../harvest'

const now = new Date('2026-03-01T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
const pod = (o: Partial<Pod> = {}): Pod => ({ slot: 2, plant: 'Arugula', plantedAt: daysAgo(19), status: 'growing', notes: '', updatedAt: '', statusSince: null, lastHarvestAt: null, ...o })
const profile = (o: Partial<PlantProfile> = {}): PlantProfile => ({ key: 'arugula', name: 'Arugula', harvestMinDays: 17, harvestMaxDays: 25, targetCover: 0.4, notes: '', source: 'agent', updatedAt: '', ...o })
/** A photo a day for the last `n` days, cover rising from `from` by `perDay`. */
const daily = (n: number, from: number, perDay: number) => Array.from({ length: n }, (_, i) => ({ ts: daysAgo(n - 1 - i), value: from + perDay * i }))

describe('matchProfile', () => {
  const profiles = [profile(), profile({ key: 'kale', name: 'Kale' }), profile({ key: 'kale lacinato', name: 'Kale Lacinato' })]

  it('takes an exact name, else the longest profile whose words all appear', () => {
    expect(matchProfile(' ARUGULA', profiles)?.name).toBe('Arugula')
    expect(matchProfile('Red Russian Kale', profiles)?.name).toBe('Kale')
    expect(matchProfile('Lacinato Kale (Dino)', profiles)?.name).toBe('Kale Lacinato')
    expect(matchProfile('Basil', profiles)).toBeNull()
    expect(matchProfile(null, profiles)).toBeNull()
  })
})

describe('outlookFor', () => {
  it('is ready once leaf cover passes the target, with the days left in the profile window', () => {
    const o = outlookFor(pod(), daily(8, 0.3, 0.02), profile(), now)
    expect(o).toMatchObject({ state: 'ready', daysToReady: 0, daysLeft: 6, cover: 0.44, window: { start: 17, end: 25, source: 'profile' } })
    expect(o.reason).toBe('Best within 6 d. Leaf cover 44%, above the 40% target.')
  })

  it('estimates days to the target from the rate, and calls it soon within a week', () => {
    const o = outlookFor(pod({ plant: 'Basil' }), daily(8, 0.14, 0.02), null, now)
    expect(o.state).toBe('soon')
    expect(o.coverPerDay).toBeCloseTo(0.02, 5)
    expect(o.daysToReady).toBeCloseTo(6, 1)
    // No profile: the camera opens a week-long window where the target is reached.
    expect(o.window).toEqual({ start: 25, end: 32, source: 'camera' })
    expect(o.reason).toBe('Leaf cover 28%, gaining 2.0% a day: about 6 d to the 40% target.')
    expect(outlookFor(pod(), daily(8, 0.02, 0.01), null, now).state).toBe('growing')
  })

  it('calls a plant whose cover has levelled off near the target ready', () => {
    const o = outlookFor(pod(), daily(8, 0.33, 0.0005), null, now)
    expect(o.state).toBe('ready')
    expect(o.reason).toBe('Best within 7 d. Leaf cover has levelled off at 33%.')
  })

  it('falls back to the profile window without photos', () => {
    expect(outlookFor(pod(), [], profile(), now)).toMatchObject({ state: 'ready', daysLeft: 6, reason: 'Day 19 of a 17–25 d window for Arugula.' })
    expect(outlookFor(pod({ plantedAt: daysAgo(12) }), [], profile(), now)).toMatchObject({ state: 'soon', daysToReady: 5, reason: '5 d until its 17–25 d window.' })
    expect(outlookFor(pod({ plantedAt: daysAgo(2) }), [], profile(), now).state).toBe('growing')
    expect(outlookFor(pod({ plantedAt: daysAgo(30) }), [], profile(), now)).toMatchObject({ state: 'ready', daysLeft: 0, reason: 'Past its 17–25 d window.' })
  })

  it('trusts a pod marked ready on Grow, and says so', () => {
    const o = outlookFor(pod({ status: 'harvest' }), daily(3, 0.2, 0.01), null, now)
    expect(o).toMatchObject({ state: 'ready', daysToReady: 0 })
    expect(o.reason).toBe('Marked ready on Grow. Leaf cover 22%, behind the 40% target.')
  })

  it('counts only regrowth after a cut, and drops the first window', () => {
    const cut = pod({ lastHarvestAt: daysAgo(2) })
    const o = outlookFor(cut, daily(8, 0.1, 0.02), profile(), now)
    // Only the last two photos follow the cut: not enough for a rate.
    expect(o).toMatchObject({ state: 'growing', window: null, coverPerDay: null })
    expect(outlookFor(cut, [], profile(), now).reason).toBe('Cut recently; waiting for photos of the regrowth.')
  })

  it('knows nothing without photos or a window', () => {
    expect(outlookFor(pod({ plantedAt: null }), [], null, now)).toMatchObject({ state: 'unknown', ageDays: null, targetCover: DEFAULT_TARGET_COVER, reason: 'No photos yet, and no planting date for a harvest window.' })
    expect(outlookFor(pod(), [], null, now).reason).toBe('No photos yet, and no harvest window for this plant.')
    // One photo gives a cover but no rate.
    expect(outlookFor(pod(), daily(1, 0.2, 0), null, now).reason).toBe('Leaf cover 20% of a 40% target; a few more photos will give a rate.')
  })

  it('ignores photos from before planting', () => {
    const o = outlookFor(pod({ plantedAt: daysAgo(3) }), daily(8, 0.5, 0), null, now)
    expect(o.coverPerDay).toBeNull()
  })
})

describe('harvestOutlook', () => {
  it('reads every planted pod against the primary analyser and its profile', () => {
    const store = new MemoryStore(4)
    store.pods.update(1, { plant: 'Arugula', status: 'growing', plantedAt: daysAgo(19) }, daysAgo(19))
    store.pods.update(3, { plant: 'Red Russian Kale', status: 'seeded', plantedAt: daysAgo(3) }, daysAgo(3))
    store.plants.upsert({ name: 'Kale', harvestMinDays: 30, harvestMaxDays: 45, targetCover: 0.5, notes: '', source: 'agent' }, 't')
    const analyzer = store.settings.get().primaryAnalyzer
    store.analyses.add(daily(8, 0.3, 0.02).map((p, i) => ({ captureId: `c${i}`, ts: p.ts, camera: 'upper', analyzer, version: 1, source: 'device', slot: 1, metric: 'green_fraction', value: p.value, detail: null, artifact: null })))
    const out = harvestOutlook(store, now)
    expect(out.map(o => [o.slot, o.state, o.profile])).toEqual([[1, 'ready', null], [3, 'growing', 'Kale']])
    expect(out[1]?.targetCover).toBe(0.5)
  })
})
