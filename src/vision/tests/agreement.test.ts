import { describe, expect, it } from 'vitest'
import type { PodLabelValue } from '../../store/types'
import { agreement, agrees } from '../agreement'

const green = (value: number) => ({ metric: 'green_fraction', value, detail: null })
const state = (s: string) => ({ metric: 'pod_state', value: 0, detail: { state: s, confidence: 0.9 } })
const row = (analyzer: string, captureId: string, slot: number, r: { metric: string, value: number, detail: Record<string, unknown> | null }, version = 1) => ({ analyzer, version, captureId, slot, ...r })
const label = (captureId: string, slot: number, l: PodLabelValue) => ({ captureId, slot, label: l })

describe('agrees', () => {
  it('wants no plant on an empty or seeded pod and one on a sprouted, growing or ready pod, at 2 %', () => {
    expect(agrees('empty', green(0))).toBe(true)
    expect(agrees('seeded', green(0.019))).toBe(true)
    expect(agrees('seeded', green(0.02))).toBe(false)
    expect(agrees('sprouted', green(0.02))).toBe(true)
    expect(agrees('growing', green(0.01))).toBe(false)
    expect(agrees('ready', green(0.4))).toBe(true)
  })

  it('leaves unhealthy pods and other metrics out of green area', () => {
    expect(agrees('unhealthy', green(0.3))).toBeNull()
    expect(agrees('growing', { metric: 'leaf_count', value: 3, detail: null })).toBeNull()
  })

  it('matches a pod-state class to the label, seeded as empty, by name or by index', () => {
    expect(agrees('growing', state('growing'))).toBe(true)
    expect(agrees('seeded', state('empty'))).toBe(true)
    expect(agrees('unhealthy', state('unhealthy'))).toBe(true)
    expect(agrees('ready', state('growing'))).toBe(false)
    // No name in the detail: the index into the model's classes (sprouted is 1).
    expect(agrees('sprouted', { metric: 'pod_state', value: 1, detail: null })).toBe(true)
  })
})

describe('agreement', () => {
  it('scores each analyser@version against the label on the same photo and pod', () => {
    const labels = [label('a', 1, 'seeded'), label('a', 2, 'growing'), label('b', 1, 'sprouted'), label('b', 3, 'unhealthy')]
    const rows = [
      row('exg-otsu', 'a', 1, green(0.16)),
      row('exg-otsu', 'a', 2, green(0.3)),
      row('exg-otsu', 'b', 1, green(0.05)),
      row('exg-otsu', 'b', 3, green(0.2)),
      row('exg-otsu', 'a', 1, green(0), 2),
      row('exg-otsu', 'a', 2, green(0.3), 2),
      // Pod 2 on photo b has no label, and photo c none at all.
      row('exg-otsu', 'b', 2, green(0.5), 2),
      row('exg-otsu', 'c', 1, green(0.5), 2),
      row('pod-state', 'a', 1, state('empty')),
      row('pod-state', 'b', 3, state('growing')),
    ]
    expect(agreement(labels, rows)).toEqual([
      { analyzer: 'exg-otsu', version: 1, metric: 'green_fraction', agree: 2, total: 3 },
      { analyzer: 'exg-otsu', version: 2, metric: 'green_fraction', agree: 2, total: 2 },
      { analyzer: 'pod-state', version: 1, metric: 'pod_state', agree: 1, total: 2 },
    ])
  })

  it('leaves out analysers with no reading on a labelled pod', () => {
    expect(agreement([label('a', 1, 'growing')], [row('exg-otsu', 'b', 1, green(0.3))])).toEqual([])
    expect(agreement([], [row('exg-otsu', 'a', 1, green(0.3))])).toEqual([])
  })
})
