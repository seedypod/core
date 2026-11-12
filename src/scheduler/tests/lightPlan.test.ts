import { describe, expect, it } from 'vitest'
import { LIGHT_PRESETS, lightHours, lightRating } from '../lightPlan'

describe('Gardyn light plan', () => {
  it('rates hours of full light as Gardyn does: 14–16 great, 17 or more too much', () => {
    expect([10, 12, 13.5, 14, 16, 16.5, 17, 18].map(lightRating)).toEqual(['low', 'ok', 'ok', 'great', 'great', 'intense', 'too much', 'too much'])
  })

  it('counts dimmed hours in part, and how long the light is on at all', () => {
    // 80% from 06:00 to 21:00, off by 21:30.
    expect(lightHours({ setpoints: [{ minute: 359, level: 0 }, { minute: 360, level: 80 }, { minute: 1260, level: 80 }, { minute: 1290, level: 0 }] })).toEqual({ full: 12, lit: 15.5 })
    expect(lightHours({ setpoints: [{ minute: 359, level: 0 }, { minute: 360, level: 100 }, { minute: 1080, level: 100 }, { minute: 1081, level: 0 }] })).toEqual({ full: 12, lit: 12 })
    expect(lightHours({ setpoints: [{ minute: 0, level: 0 }] })).toEqual({ full: 0, lit: 0 })
  })

  it('rates a ramp in 25% steps from 06:00, full 12:00–17:30, as low, and on long enough to bolt', () => {
    const steps = [[360, 25], [480, 50], [600, 75], [720, 100], [1050, 75], [1170, 50], [1290, 25], [1410, 0]] as const
    const setpoints = [{ minute: 359, level: 0 }, ...steps.flatMap(([minute, level], i) => [{ minute, level }, { minute: (steps[i + 1]?.[0] ?? 1411) - 1, level }])].slice(0, -1)
    const hours = lightHours({ setpoints })
    expect(hours).toEqual({ full: 11.5, lit: 17.5 })
    expect(lightRating(hours.full)).toBe('low')
  })

  it('has presets whose names give their hours of full light, all rated great', () => {
    expect(LIGHT_PRESETS.map(p => [p.id, lightHours(p), lightRating(lightHours(p).full)])).toEqual([
      ['day-15h', { full: 15, lit: 15.5 }, 'great'],
      ['day-14h', { full: 14, lit: 14.5 }, 'great'],
      ['day-16h', { full: 16, lit: 16.5 }, 'great'],
      ['gentle-14h', { full: 14, lit: 16 }, 'great'],
    ])
  })
})
