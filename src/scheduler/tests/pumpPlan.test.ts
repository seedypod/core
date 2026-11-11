import { describe, expect, it } from 'vitest'
import { GARDYN_WATERING_GUIDE, presetSchedules, PUMP_PRESETS } from '../pumpPlan'

describe('pump presets', () => {
  it('offers twice, three times and once a day, each within the 15-minute run limit', () => {
    expect(PUMP_PRESETS.map(p => [p.name, p.minutes, p.durationS])).toEqual([
      ['Twice a day · 10 min', [480, 1020], 600],
      ['Three times a day · 5 min', [480, 780, 1080], 300],
      ['Once a day · 15 min', [480], 900],
    ])
    for (const p of PUMP_PRESETS) expect(p.durationS).toBeLessThanOrEqual(900)
    expect(GARDYN_WATERING_GUIDE).toBe('https://help.mygardyn.com/en/articles/4435265')
  })

  it('makes one daily pump schedule per run time, named for the preset and its time', () => {
    const [twice] = PUMP_PRESETS
    expect(presetSchedules(twice as typeof PUMP_PRESETS[number], { enabled: true, idPrefix: 'pump-x' })).toEqual([
      { id: 'pump-x-480', kind: 'pump', name: 'Twice a day · 10 min (08:00)', enabled: true, days: 127, spec: { minute: 480, durationS: 600 } },
      { id: 'pump-x-1020', kind: 'pump', name: 'Twice a day · 10 min (17:00)', enabled: true, days: 127, spec: { minute: 1020, durationS: 600 } },
    ])
    expect(presetSchedules(PUMP_PRESETS[2] as typeof PUMP_PRESETS[number], { enabled: false, idPrefix: 'p' })[0]?.enabled).toBe(false)
  })
})
