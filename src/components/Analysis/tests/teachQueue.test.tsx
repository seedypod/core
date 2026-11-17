import { describe, expect, it } from 'vitest'
import { podRegions } from '@/src/vision/regions'
import { teachSummary, waiting } from '../TeachQueue'

const hint = (slot: number) => ({ slot, label: 'empty' as const, by: 'carry', confidence: null, from: null })

describe('Teach queue', () => {
  it('counts a suggestion as waiting only on a pod with a box and no label', () => {
    const regions = Object.fromEntries(Object.entries(podRegions('upper')).filter(([s]) => s !== '4'))
    expect(waiting([hint(1), hint(2), hint(4)], [{ slot: 2 }], regions).map(h => h.slot)).toEqual([1])
    expect(waiting(undefined, undefined, regions)).toEqual([])
    expect(waiting([hint(3)], undefined, regions).map(h => h.slot)).toEqual([3])
  })

  it('says how many pods are labelled, in the singular too, and each suggester without its version', () => {
    expect(teachSummary({ pods: 1, suggesters: [] })).toBe('1 pod labelled')
    expect(teachSummary({ pods: 0, suggesters: [] })).toBe('0 pods labelled')
    expect(teachSummary({ pods: 12, suggesters: [{ by: 'pod-state@3', accepted: 2, corrected: 1, right: 0.667 }] })).toBe('12 pods labelled · pod-state 67% right')
  })
})
