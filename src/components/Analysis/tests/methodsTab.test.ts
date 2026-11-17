import { describe, expect, it } from 'vitest'
import { podReading, spread } from '../MethodsTab'

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

describe('spread', () => {
  it('keeps the first and the last, evenly between', () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([1, 3, 4, 6, 7])
    expect(spread([1, 2], 5)).toEqual([1, 2])
  })
})
