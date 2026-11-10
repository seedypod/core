import { describe, expect, it } from 'vitest'
import { boostHours, LIGHT_PRESETS, lightRating } from '../lightPlan'

describe('Gardyn light plan', () => {
  it('rates Boost hours as Gardyn does: 14–16 great, 17 or more too much', () => {
    expect([10, 12, 13.5, 14, 16, 16.5, 17, 18].map(lightRating)).toEqual(['low', 'ok', 'ok', 'great', 'great', 'intense', 'too much', 'too much'])
  })

  it('counts only hours at full brightness, not dimmed ones', () => {
    expect(boostHours({ setpoints: [{ minute: 360, level: 80 }, { minute: 1260, level: 80 }, { minute: 1290, level: 0 }] })).toBe(0)
    expect(boostHours({ setpoints: [{ minute: 359, level: 0 }, { minute: 360, level: 100 }, { minute: 1080, level: 100 }, { minute: 1081, level: 0 }] })).toBe(12)
  })

  it('has presets of 15, 14 and 16 Boost hours, all rated great', () => {
    expect(LIGHT_PRESETS.map(p => [p.id, boostHours({ setpoints: p.setpoints }), lightRating(boostHours({ setpoints: p.setpoints }))])).toEqual([
      ['day-15h', 15, 'great'],
      ['day-14h', 14, 'great'],
      ['day-16h', 16, 'great'],
    ])
  })
})
