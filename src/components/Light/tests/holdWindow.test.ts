import { describe, expect, it } from 'vitest'
import { holdWindow } from '../LightPage'

describe('holdWindow', () => {
  const now = new Date(2026, 10, 10, 14, 0)
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()

  it('runs from when the light was set until it hands back, in minutes of today', () => {
    expect(holdWindow(at(10, 13, 30), at(10, 14, 30), now)).toEqual({ fromMin: 810, untilMin: 870 })
  })

  it('clamps a hold set yesterday to midnight and one ending tomorrow to the day\'s end', () => {
    expect(holdWindow(at(9, 23), at(11, 1), now)).toEqual({ fromMin: 0, untilMin: 1440 })
  })
})
