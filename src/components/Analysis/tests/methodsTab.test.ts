import { describe, expect, it } from 'vitest'
import { labelMarks, labelReading, podReading, spread } from '../MethodsTab'

const s = (name: string, ...values: number[]) => ({ name, values })

describe('podReading', () => {
  it('names the versions that read plant on a seeded or empty pod, and the ones that hold under 2 %', () => {
    expect(podReading('seeded', [s('a@1', 0, 0.16), s('b@2', 0, 0.01)])).toBe('a@1 up to 16% on this seeded pod; b@2 holds under 2%, as it should.')
    expect(podReading('empty', [s('a@1', 0.01), s('b@2', 0)])).toBe('Every version holds under 2% on this empty pod.')
    expect(podReading('seeded', [s('a@1', 0.03), s('b@2', 0.05)])).toBe('Every version reads plant on this seeded pod at times: a@1 up to 3% and b@2 up to 5%.')
  })

  it('names the versions that miss a growing plant on its newest photo', () => {
    expect(podReading('growing', [s('a@1', 0.3, 0.01), s('b@2', 0.2), s('c@1', 0, 0)])).toBe('a@1 and c@1 read under 2% on the newest photo, though the pod is growing.')
    expect(podReading('harvest', [s('a@1', 0.3)])).toBe('Every version sees the plant on the newest photo of this ready to harvest pod.')
  })

  it('says nothing for a pod needing attention, an unknown one, or nothing charted', () => {
    expect(podReading('attention', [s('a@1', 0.3)])).toBeNull()
    expect(podReading(undefined, [s('a@1', 0.3)])).toBeNull()
    expect(podReading('seeded', [s('a@1')])).toBeNull()
  })
})

const pts = (name: string, ...values: Array<[string, number]>) => ({ name, points: values.map(([captureId, value]) => ({ captureId, value })) })
const l = (captureId: string, label: 'empty' | 'seeded' | 'sprouted' | 'growing' | 'ready' | 'unhealthy') => ({ captureId, label })

describe('labelReading', () => {
  const seeded = [l('a', 'seeded'), l('b', 'seeded'), l('c', 'seeded'), l('d', 'seeded')]

  it('names the versions that disagree with the labels at the labelled photos, and the ones that agree', () => {
    const v1 = pts('exg-otsu@1', ['a', 0.05], ['b', 0.03], ['c', 0.01], ['d', 0.2], ['x', 0.4])
    const v2 = pts('exg-otsu@2', ['a', 0], ['b', 0.01], ['c', 0], ['d', 0.019])
    const g2 = pts('green-threshold@2', ['a', 0], ['b', 0], ['c', 0], ['d', 0])
    expect(labelReading(seeded, [v1, v2, g2])).toBe('exg-otsu@1 read over 2% on 3 of 4 photos you labelled seeded; the @2 versions agree.')
    expect(labelReading(seeded, [pts('a@1', ['a', 0.1], ['b', 0.1], ['c', 0.1])])).toBe('a@1 read over 2% on all 3 photos you labelled seeded.')
    expect(labelReading(seeded, [v1, v2])).toBe('exg-otsu@1 read over 2% on 3 of 4 photos you labelled seeded; exg-otsu@2 agrees.')
    // Versions of mixed numbers are named.
    const g1 = pts('green-threshold@1', ['a', 0], ['b', 0])
    expect(labelReading(seeded, [v1, v2, g1])).toBe('exg-otsu@1 read over 2% on 3 of 4 photos you labelled seeded; exg-otsu@2 and green-threshold@1 agree.')
    // A version of the agreeing number that disagrees stops them reading as that number's versions.
    const w2 = pts('wide@2', ['a', 0.5])
    expect(labelReading(seeded, [v2, g2, w2])).toBe('wide@2 read over 2% on the photo you labelled seeded; exg-otsu@2 and green-threshold@2 agree.')
  })

  it('reads a plant label the other way about, and each label apart', () => {
    const labels = [l('a', 'seeded'), l('b', 'sprouted'), l('c', 'growing'), l('d', 'growing')]
    expect(labelReading(labels, [pts('a@1', ['a', 0.3], ['b', 0.01], ['c', 0], ['d', 0.001]), pts('b@1', ['a', 0], ['b', 0.01], ['c', 0.4], ['d', 0.5])]))
      .toBe('a@1 read over 2% on the photo you labelled seeded, under 2% on the photo you labelled sprouted and under 2% on both photos you labelled growing; b@1 read under 2% on the photo you labelled sprouted.')
  })

  it('says when every version agrees', () => {
    expect(labelReading(seeded, [pts('a@1', ['a', 0], ['b', 0]), pts('b@1', ['b', 0.01])])).toBe('Every version agrees with your labels on both photos you labelled.')
    expect(labelReading([l('a', 'ready')], [pts('a@1', ['a', 0.6])])).toBe('Every version agrees with your labels on the photo you labelled.')
    expect(labelReading(seeded, [pts('a@1', ['a', 0], ['b', 0], ['c', 0])])).toBe('Every version agrees with your labels on all 3 photos you labelled.')
  })

  it('says nothing with no label on a charted photo, or only unhealthy ones, so the record speaks', () => {
    expect(labelReading([], [pts('a@1', ['a', 0.3])])).toBeNull()
    expect(labelReading([l('z', 'seeded')], [pts('a@1', ['a', 0.3])])).toBeNull()
    expect(labelReading([l('a', 'unhealthy')], [pts('a@1', ['a', 0.3])])).toBeNull()
    expect(labelReading(seeded, [])).toBeNull()
  })
})

describe('labelMarks', () => {
  it('marks the first label and each change', () => {
    const at = (ts: string, label: 'seeded' | 'sprouted' | 'growing' | 'unhealthy') => ({ ts, label })
    expect(labelMarks([at('2026-01-01T00:00:00Z', 'seeded'), at('2026-01-02T00:00:00Z', 'seeded'), at('2026-01-03T00:00:00Z', 'sprouted'), at('2026-01-04T00:00:00Z', 'unhealthy'), at('2026-01-05T00:00:00Z', 'growing')]))
      .toEqual([
        { x: Date.parse('2026-01-01T00:00:00Z'), label: 'seeded' },
        { x: Date.parse('2026-01-03T00:00:00Z'), label: 'sprouted' },
        { x: Date.parse('2026-01-04T00:00:00Z'), label: 'unhealthy' },
        { x: Date.parse('2026-01-05T00:00:00Z'), label: 'growing' },
      ])
    expect(labelMarks([])).toEqual([])
  })
})

describe('spread', () => {
  it('keeps the first and the last, evenly between', () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([1, 3, 4, 6, 7])
    expect(spread([1, 2], 5)).toEqual([1, 2])
  })
})
