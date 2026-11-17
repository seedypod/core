import { describe, expect, it } from 'vitest'
import { getPlant, sproutWindow } from '@/src/plants/catalog'
import { coverChange, labelledBy, podDay, podsSummary, podState, shortName, sproutChip, sprouting, windowText } from '../pods'

const pod = (status: 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention', plantedAt: string | null = '2026-01-01') => ({ slot: 16, plant: 'Red Swiss Chard', plantedAt, status, notes: '', updatedAt: '2026-01-01T00:00:00Z', statusSince: null, lastHarvestAt: null })
const label = { captureId: 'c', ts: '2026-01-09T08:00:00Z', camera: 'lower' as const, slot: 16, label: 'sprouted' as const, labelledAt: '2026-01-09T09:00:00Z', plant: null, plantedAt: null, source: 'picked' as const, suggested: null, suggestedBy: null, suggestedConfidence: null }
const window = { days: [7, 21] as [number, number], estimated: false }

describe('sprouting', () => {
  it('calls a pod still seeded after its plant\'s last sprouting day late, and on time until then', () => {
    expect(sprouting('seeded', 3, window)).toBe('on time')
    expect(sprouting('seeded', 21, window)).toBe('on time')
    expect(sprouting('seeded', 22, window)).toBe('late')
  })

  it('says a pod showing a sprout or more has sprouted, whatever its day', () => {
    expect(sprouting('sprouted', 30, window)).toBe('sprouted')
    expect(sprouting('growing', 2, window)).toBe('sprouted')
    expect(sprouting('ready', 60, window)).toBe('sprouted')
  })

  it('says nothing for an empty or unhealthy pod, or without a day or a window', () => {
    expect(sprouting('empty', 30, window)).toBeNull()
    expect(sprouting('unhealthy', 30, window)).toBeNull()
    expect(sprouting('seeded', null, window)).toBeNull()
    expect(sprouting('seeded', 30, null)).toBeNull()
  })

  it('takes the window from the Plant Book, or the category\'s median flagged estimated', () => {
    const of = (id: string) => {
      const p = getPlant(id)
      return p ? sproutWindow(p) : undefined
    }
    expect(of('red-swiss-chard')).toEqual({ days: [7, 21], estimated: false })
    expect(of('green-bok-choy')).toEqual({ days: [5, 10], estimated: false })
    expect(of('tokyo-bekana')).toEqual({ days: [6, 21], estimated: true })
    expect(sproutWindow({ id: 'custom', category: 'vegetable' })).toEqual({ days: [4, 7], estimated: true })
    expect(windowText({ days: [5, 10], estimated: false })).toBe('day 5–10 typical')
    expect(windowText({ days: [7, 10], estimated: true })).toBe('about day 7–10')
  })
})

describe('podState', () => {
  it('keeps a pod with no record, or marked empty, empty whatever was labelled', () => {
    expect(podState(undefined, label, undefined).stage).toBe('empty')
    expect(podState(pod('empty'), label, undefined)).toMatchObject({ stage: 'empty', from: 'record' })
  })

  it('takes the label on the photo, then the suggestion, then the record', () => {
    expect(podState(pod('seeded'), label, { slot: 16, label: 'seeded', by: 'carry', confidence: null, from: '2026-01-05T08:00:00Z' })).toMatchObject({ stage: 'sprouted', from: 'label', at: '2026-01-09T09:00:00Z' })
    expect(podState(pod('seeded'), undefined, { slot: 16, label: 'seeded', by: 'carry', confidence: null, from: '2026-01-05T08:00:00Z' })).toMatchObject({ stage: 'seeded', from: 'carry', at: '2026-01-05T08:00:00Z' })
    expect(podState(pod('seeded'), undefined, { slot: 16, label: 'growing', by: 'pod-state@2', confidence: 0.86, from: null })).toMatchObject({ stage: 'growing', from: 'model', by: 'pod-state@2', confidence: 0.86 })
    expect(podState(pod('seeded'), undefined, { slot: 16, label: 'seeded', by: 'record', confidence: null, from: null })).toMatchObject({ stage: 'seeded', from: 'record' })
    expect(podState(pod('harvest'), undefined, undefined).stage).toBe('ready')
    expect(podState(pod('attention'), undefined, undefined).stage).toBe('unhealthy')
  })

  it('says who labelled it', () => {
    expect(labelledBy(podState(pod('seeded'), label, undefined))).toMatch(/^you · /)
    expect(labelledBy(podState(pod('seeded'), undefined, { slot: 16, label: 'growing', by: 'pod-state@2', confidence: 0.86, from: null }))).toBe('pod-state 86%')
    expect(labelledBy(podState(pod('seeded'), undefined, undefined))).toBe('pod record')
  })
})

describe('the words', () => {
  it('counts whole days since sowing', () => {
    expect(podDay('2026-01-01', new Date('2026-01-09T12:00:00Z'))).toBe(8)
    expect(podDay(null)).toBeNull()
  })

  it('shortens a plant to its last words for a tag', () => {
    expect(shortName('Perpetual Spinach')).toBe('Spinach')
    expect(shortName('Red Swiss Chard')).toBe('Chard')
    expect(shortName('Green Bok Choy')).toBe('Bok Choy')
    expect(shortName('Red Salad Bowl')).toBe('Salad Bowl')
    expect(shortName('Buttercrunch')).toBe('Buttercrunch')
  })

  it('gives leaf cover with its change over the recent photos', () => {
    expect(coverChange([0, 0.004, 0.012], 0.012)).toBe('1% ↑ from 0%')
    expect(coverChange([0.3, 0.2], 0.2)).toBe('20% ↓ from 30%')
    expect(coverChange([0.2, 0.201], 0.201)).toBe('20%')
    expect(coverChange([], 0.05)).toBe('5%')
    expect(coverChange([0.1], null)).toBeNull()
  })

  it('chips the day against the window', () => {
    expect(sproutChip(8, 'on time')).toBe('day 8 · on time')
    expect(sproutChip(8, null)).toBe('day 8')
    expect(sproutChip(null, 'late')).toBeNull()
  })

  it('sums up the tower', () => {
    const pods = [{ stage: 'sprouted' as const, sprout: 'sprouted' as const }, { stage: 'growing' as const, sprout: null }, { stage: 'seeded' as const, sprout: 'late' as const }, { stage: 'seeded' as const, sprout: 'late' as const }, { stage: 'empty' as const, sprout: null }]
    expect(podsSummary(8, pods)).toBe('Day 8 · 4 planted · 2 sprouted · 2 look late')
    expect(podsSummary(null, pods.slice(2, 3))).toBe('1 planted · 1 looks late')
    expect(podsSummary(3, [])).toBe('Day 3 · 0 planted')
  })
})
