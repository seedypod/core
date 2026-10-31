import { describe, expect, it } from 'vitest'
import { lightHue, skyHue } from '../hues'

describe('skyHue', () => {
  it('is periodic over a day', () => {
    expect(skyHue(0)).toBe(skyHue(1440))
    expect(skyHue(-60)).toBe(skyHue(1380))
  })
  it('is pale sky at midday', () => {
    expect(skyHue(720)).toBe(205)
  })
})

describe('lightHue', () => {
  it('clamps to 0..100', () => {
    expect(lightHue(-10)).toBe(lightHue(0))
    expect(lightHue(500)).toBe(lightHue(100))
  })
  it('warms up with brightness', () => {
    expect(lightHue(100)).toBeGreaterThan(lightHue(0))
  })
})
