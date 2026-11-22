import { describe, expect, it } from 'vitest'
import type { Reading } from '../contract'
import { QUALITY_WINDOW_MS, QualityTracker } from '../quality'

const r = (value: number, quality: Reading['quality']): Reading => ({ ts: '2026-11-22T12:00:00Z', value, unit: '%', quality })

describe('QualityTracker', () => {
  it('counts the last hour\'s flaky readings per sensor and keeps the last good one past it', () => {
    const q = new QualityTracker()
    q.record('water_level_pct', r(60, 'good'), 0)
    q.record('water_level_pct', r(5, 'suspect'), 1000)
    q.record('ec', r(1.2, 'stale'), 1000)
    expect(q.get(1000)).toEqual({ water_level_pct: { flaky: 1, total: 2, lastGood: r(60, 'good') }, ec: { flaky: 0, total: 1, lastGood: null } })
    q.record('water_level_pct', r(4, 'suspect'), QUALITY_WINDOW_MS + 500)
    expect(q.get(QUALITY_WINDOW_MS + 500).water_level_pct).toEqual({ flaky: 2, total: 2, lastGood: r(60, 'good') })
    expect(q.get(3 * QUALITY_WINDOW_MS).water_level_pct).toEqual({ flaky: 0, total: 0, lastGood: r(60, 'good') })
  })
})
