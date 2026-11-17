import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import type { PodStatus } from '../../store/types'
import { seenEmpty } from '../seenEmpty'

const NOW = new Date('2026-11-16T12:00:00.000Z')
const SOWN = '2026-11-01T09:00:00.000Z'

function unit() {
  const store = new MemoryStore()
  const plant = (slot: number, status: PodStatus = 'growing', ts = SOWN) => store.pods.update(slot, { plant: 'Kale', plantedAt: '2026-11-01', status }, ts)
  const scored = (slot: number, state: string, confidence: number, ts = '2026-11-16T10:00:00Z', version = 1, captureId = `upper-${ts}`) =>
    store.analyses.add([{ captureId, ts, camera: 'upper', analyzer: 'pod-state', version, source: 'device', slot, metric: 'pod_state', value: 0, detail: { state, confidence }, artifact: null }])
  return { store, plant, scored }
}

describe('seenEmpty', () => {
  it('names planted pods the newest photo confidently shows empty', () => {
    const { store, plant, scored } = unit()
    plant(4)
    plant(5, 'harvest')
    plant(6, 'attention')
    plant(7)
    scored(4, 'empty', 0.93)
    scored(5, 'empty', 0.8)
    scored(6, 'empty', 0.97)
    scored(7, 'growing', 0.95)
    expect(seenEmpty(store, NOW)).toEqual([
      { slot: 4, confidence: 0.93, ts: '2026-11-16T10:00:00Z' },
      { slot: 5, confidence: 0.8, ts: '2026-11-16T10:00:00Z' },
      { slot: 6, confidence: 0.97, ts: '2026-11-16T10:00:00Z' },
    ])
  })

  it('skips unsure, stale, superseded and pre-record photos, and pods that are seeded or empty', () => {
    const { store, plant, scored } = unit()
    // Below the tagger's 0.8.
    plant(1)
    scored(1, 'empty', 0.79)
    // Newest photo is over two days old.
    plant(2)
    scored(2, 'empty', 0.99, '2026-11-14T11:00:00Z')
    // An earlier photo said empty; the newest one doesn't.
    plant(3)
    scored(3, 'empty', 0.99, '2026-11-16T08:00:00Z')
    scored(3, 'sprouted', 0.9, '2026-11-16T10:00:00Z')
    // The record changed (a swap, a replant) after the photo.
    plant(8, 'growing', '2026-11-16T11:00:00.000Z')
    scored(8, 'empty', 0.99)
    // The model has no seeded class; a sown yCube looks empty.
    plant(9, 'seeded')
    scored(9, 'empty', 0.99)
    // Already empty.
    scored(10, 'empty', 0.99)
    // Planted, never scored.
    plant(11)
    // A result with no detail.
    plant(12)
    store.analyses.add([{ captureId: 'x', ts: '2026-11-16T10:00:00Z', camera: 'upper', analyzer: 'pod-state', version: 1, source: 'device', slot: 12, metric: 'pod_state', value: 0, detail: null, artifact: null }])
    expect(seenEmpty(store, NOW)).toEqual([])
  })

  it('reads only the newest model version', () => {
    const { store, plant, scored } = unit()
    plant(4)
    plant(5)
    scored(4, 'empty', 0.95, '2026-11-16T10:00:00Z', 1, 'c1')
    scored(4, 'growing', 0.9, '2026-11-16T10:00:00Z', 2, 'c1')
    scored(5, 'growing', 0.95, '2026-11-16T10:00:00Z', 1, 'c1')
    scored(5, 'empty', 0.9, '2026-11-16T10:00:00Z', 2, 'c1')
    expect(seenEmpty(store, NOW).map(s => s.slot)).toEqual([5])
  })
})
