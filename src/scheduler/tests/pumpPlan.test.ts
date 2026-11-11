import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { anchor } from '../../care/knowledge'
import { dailyMinutes, daysSinceSowing, GARDYN_WATERING_GUIDE, lightWindow, presetRuns, appliedPreset, plantCategories, presetSchedules, PUMP_PRESETS, recommendedPreset, TIPS_CITATION, WATERING_TIPS, type PumpPreset } from '../pumpPlan'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const preset = (id: string) => PUMP_PRESETS.find(p => p.id === id) as PumpPreset

describe('pump presets', () => {
  it('runs by growth stage: once, twice, three and five times a day, within the run limit and their own ranges', () => {
    expect(PUMP_PRESETS.map(p => [p.id, p.minutes, p.durationS])).toEqual([
      ['seedlings', [480], 600],
      ['young', [480, 960], 360],
      ['mature', [480, 840, 1200], 360],
      ['fruiting', [360, 600, 840, 1080, 1320], 300],
    ])
    for (const p of PUMP_PRESETS) {
      expect(p.durationS).toBeLessThanOrEqual(900)
      expect(p.durationS).toBeGreaterThanOrEqual(p.range.minS)
      expect(p.durationS).toBeLessThanOrEqual(p.range.maxS)
    }
    expect(GARDYN_WATERING_GUIDE).toBe('https://help.mygardyn.com/en/articles/4435265')
  })

  it('cites a note section that exists for each preset and for the tips, and the note gives their numbers', () => {
    const note = readFileSync(`${ROOT}knowledge/watering/schedules.md`, 'utf8')
    const headings = note.split('\n').filter(l => /^#{1,6} /.test(l)).map(l => l.replace(/^#+ /, '').trim())
    for (const c of [...PUMP_PRESETS.map(p => p.citation), TIPS_CITATION]) {
      expect(headings).toContain(c.section)
      expect(c.url).toBe(`https://github.com/seedypod/core/blob/dev/knowledge/watering/schedules.md#${anchor(c.section)}`)
    }
    expect(note).toContain('once a day: 10 min (5–15 min) at 08:00')
    expect(note).toContain('Twice a day, 6 min (5–8 min), at 08:00 and 16:00')
    expect(note).toContain('Three times a day, 6 min (5–8 min), at 08:00, 14:00 and 20:00')
    expect(note).toContain('06:00, 10:00, 14:00, 18:00 and 22:00')
    expect(note).toContain(GARDYN_WATERING_GUIDE)
    expect(note).toMatch(/not Gardyn's guidance/)
    expect(WATERING_TIPS[0]).toMatch(/Check the roots/)
  })

  it('finds the light window across the running curves', () => {
    expect(lightWindow([])).toBeNull()
    expect(lightWindow([{ setpoints: [{ minute: 0, level: 0 }] }])).toBeNull()
    const day = { setpoints: [{ minute: 330, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1290, level: 0 }] }
    expect(lightWindow([day])).toEqual({ on: 331, off: 1290 })
  })

  it('keeps fruiting runs inside a shorter light day, and the rest as they are', () => {
    expect(presetRuns(preset('fruiting'), { on: 420, off: 1260 })).toEqual([600, 840, 1080])
    expect(presetRuns(preset('fruiting'), null)).toEqual([360, 600, 840, 1080, 1320])
    expect(presetRuns(preset('fruiting'), { on: 0, off: 60 })).toEqual([360, 600, 840, 1080, 1320])
    expect(presetRuns(preset('mature'), { on: 600, off: 700 })).toEqual([480, 840, 1200])
    expect(dailyMinutes(3, 360)).toBe(18)
  })

  it('makes one daily pump schedule per run, with ids and names by stage and time', () => {
    expect(presetSchedules(preset('mature'), { enabled: true })).toEqual([
      { id: 'water-mature-0800', kind: 'pump', name: 'Mature · 3× 6 min (08:00)', enabled: true, days: 127, spec: { minute: 480, durationS: 360 } },
      { id: 'water-mature-1400', kind: 'pump', name: 'Mature · 3× 6 min (14:00)', enabled: true, days: 127, spec: { minute: 840, durationS: 360 } },
      { id: 'water-mature-2000', kind: 'pump', name: 'Mature · 3× 6 min (20:00)', enabled: true, days: 127, spec: { minute: 1200, durationS: 360 } },
    ])
    // Exactly the cycle already on the unit, so it reads as applied.
    expect(presetSchedules(preset('seedlings'), { enabled: false })[0]).toMatchObject({ id: 'water-seedlings-0800', name: 'Seedlings · once a day 10 min (08:00)', enabled: false })
    expect(presetSchedules(preset('fruiting'), { enabled: true, light: { on: 420, off: 1260 } }).map(s => s.name)).toEqual(['Fruiting · 3× 5 min (10:00)', 'Fruiting · 3× 5 min (14:00)', 'Fruiting · 3× 5 min (18:00)'])
  })
})

describe('recommending a preset', () => {
  const now = new Date('2026-11-20T12:00:00Z')

  it('counts days from the grow cycle, else the earliest planted pod', () => {
    expect(daysSinceSowing('2026-11-10T08:00:00Z', ['2026-10-01'], now)).toBe(10)
    expect(daysSinceSowing(null, ['2026-11-15', null, '2026-11-12'], now)).toBe(8)
    expect(daysSinceSowing(undefined, [null], now)).toBeNull()
    expect(daysSinceSowing('2026-12-01T00:00:00Z', [], now)).toBe(0)
  })

  it('picks by stage, and fruiting whenever a fruiting crop is planted, saying why', () => {
    // The first days are Gardyn's soak: Seedlings, marked as nothing new to run yet.
    expect(recommendedPreset(0, ['herb'])).toEqual({ id: 'seedlings', why: 'day 0 since sowing, the soak: Gardyn waits a few days to a week after sowing before the second watering.', soak: true })
    expect(recommendedPreset(2, [])?.soak).toBe(true)
    expect(recommendedPreset(3, [])).toEqual({ id: 'seedlings', why: 'day 3 since sowing' })
    expect(recommendedPreset(7, [])?.id).toBe('seedlings')
    expect(recommendedPreset(8, [])?.id).toBe('young')
    expect(recommendedPreset(21, [])?.id).toBe('young')
    expect(recommendedPreset(22, ['green'])).toEqual({ id: 'mature', why: 'day 22 since sowing' })
    expect(recommendedPreset(null, [])).toBeNull()
    expect(recommendedPreset(3, ['herb', 'fruiting'])).toEqual({ id: 'fruiting', why: 'a fruiting crop is planted' })
    expect(recommendedPreset(null, ['fruiting'])?.id).toBe('fruiting')
  })

  it('reads the planted plants\' catalog categories, skipping unknown names', () => {
    expect(plantCategories(['Cucumber', null, 'Not a plant', 'Basil'])).toEqual(['fruiting', expect.any(String)])
  })

  it('knows which preset the cycles are, and none when they differ', () => {
    const mature = presetSchedules(preset('mature'), { enabled: true })
    expect(appliedPreset(mature, null)).toBe('mature')
    expect(appliedPreset([{ id: 'water-seedlings-0800', spec: { minute: 480, durationS: 600 } }], null)).toBe('seedlings')
    // Under another id, its name still says which it is.
    expect(appliedPreset([{ id: 'water-old-0800', name: 'Seedlings · once a day 10 min (08:00)', spec: { minute: 480, durationS: 600 } }], null)).toBe('seedlings')
    expect(appliedPreset([{ id: 'other', name: 'Mine', spec: { minute: 480, durationS: 600 } }], null)).toBeNull()
    expect(appliedPreset(mature.slice(1), null)).toBeNull()
    expect(appliedPreset([{ ...mature[0] as typeof mature[number], spec: { minute: 480, durationS: 300 } }, ...mature.slice(1)], null)).toBeNull()
    expect(appliedPreset([], null)).toBeNull()
  })
})
