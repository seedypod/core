import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { anchor } from '../../care/knowledge'
import { advances, dailyMinutes, daysSinceSowing, sowDate, GARDYN_WATERING_GUIDE, lightPeriods, lightWindow, presetRuns, appliedPreset, plantCategories, presetDays, presetSchedules, PUMP_PRESETS, recommendedPreset, sowWeekday, TIPS_CITATION, WATERING_TIPS, type PumpPreset } from '../pumpPlan'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const preset = (id: string) => PUMP_PRESETS.find(p => p.id === id) as PumpPreset

describe('pump presets', () => {
  it('runs by growth stage: once a week, then once, twice, three and five times a day, within the run limit and their own ranges', () => {
    expect(PUMP_PRESETS.map(p => [p.id, p.minutes, p.durationS])).toEqual([
      ['germination', [480], 900],
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
    expect(note).toContain('Once a week, 15 min at 08:00, on the sowing weekday')
    expect(note).toContain('Once a day, 10 min (5–15 min), at 08:00')
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
    // At Boost, 95 or brighter: the ramps don't count.
    expect(lightWindow([day], 95)).toEqual({ on: 359, off: 1262 })
  })

  it('finds each stretch of light, joining one that runs over midnight', () => {
    expect(lightPeriods([])).toEqual([])
    // Two separate curves: morning and evening at full brightness.
    const morning = { setpoints: [{ minute: 360, level: 100 }, { minute: 540, level: 100 }, { minute: 541, level: 0 }, { minute: 359, level: 0 }] }
    const evening = { setpoints: [{ minute: 1080, level: 100 }, { minute: 1260, level: 100 }, { minute: 1261, level: 0 }, { minute: 1079, level: 0 }] }
    expect(lightPeriods([morning, evening], 95)).toEqual([{ on: 360, off: 541 }, { on: 1080, off: 1261 }])
    // On from 22:00 to 06:00: one stretch over midnight.
    const night = { setpoints: [{ minute: 360, level: 100 }, { minute: 361, level: 0 }, { minute: 1319, level: 0 }, { minute: 1320, level: 100 }] }
    expect(lightPeriods([night], 95)).toEqual([{ on: 1320, off: 361 }])
    // All day.
    expect(lightPeriods([{ setpoints: [{ minute: 0, level: 100 }] }])).toEqual([{ on: 0, off: 1440 }])
  })

  it('keeps fruiting runs inside a shorter light day, and the rest as they are', () => {
    expect(presetRuns(preset('fruiting'), { on: 420, off: 1260 })).toEqual([600, 840, 1080])
    expect(presetRuns(preset('fruiting'), null)).toEqual([360, 600, 840, 1080, 1320])
    expect(presetRuns(preset('fruiting'), { on: 0, off: 60 })).toEqual([360, 600, 840, 1080, 1320])
    expect(presetRuns(preset('mature'), { on: 600, off: 700 })).toEqual([480, 840, 1200])
    expect(dailyMinutes(3, 360)).toBe(18)
  })

  it('makes one daily pump schedule per run, with ids and names by stage and time', () => {
    expect(presetSchedules(preset('mature'), { enabled: true, weekday: 3 })).toEqual([
      { id: 'water-mature-0800', kind: 'pump', name: 'Mature · 3× 6 min (08:00)', enabled: true, days: 127, spec: { minute: 480, durationS: 360 } },
      { id: 'water-mature-1400', kind: 'pump', name: 'Mature · 3× 6 min (14:00)', enabled: true, days: 127, spec: { minute: 840, durationS: 360 } },
      { id: 'water-mature-2000', kind: 'pump', name: 'Mature · 3× 6 min (20:00)', enabled: true, days: 127, spec: { minute: 1200, durationS: 360 } },
    ])
    // Germination runs once a week, on the sowing weekday: Thursday here.
    expect(presetSchedules(preset('germination'), { enabled: true, weekday: 3 })).toEqual([
      { id: 'water-germination-0800', kind: 'pump', name: 'Germination · once a week 15 min (08:00)', enabled: true, days: 8, spec: { minute: 480, durationS: 900 } },
    ])
    expect(presetDays(preset('young'), 3)).toBe(127)
    // Exactly the cycle already on the unit, so it reads as applied.
    expect(presetSchedules(preset('seedlings'), { enabled: false, weekday: 0 })[0]).toMatchObject({ id: 'water-seedlings-0800', name: 'Seedlings · once a day 10 min (08:00)', enabled: false })
    expect(presetSchedules(preset('fruiting'), { enabled: true, light: { on: 420, off: 1260 }, weekday: 0 }).map(s => s.name)).toEqual(['Fruiting · 3× 5 min (10:00)', 'Fruiting · 3× 5 min (14:00)', 'Fruiting · 3× 5 min (18:00)'])
  })
})

describe('recommending a preset', () => {
  const now = new Date('2026-11-20T12:00:00Z')

  it('counts days from the grow cycle, else the earliest planted pod', () => {
    expect(daysSinceSowing('2026-11-10T08:00:00Z', ['2026-10-01'], now, 'UTC')).toBe(10)
    expect(daysSinceSowing(null, ['2026-11-15', null, '2026-11-12'], now, 'UTC')).toBe(8)
    expect(daysSinceSowing(undefined, [null], now, 'UTC')).toBeNull()
    expect(daysSinceSowing('2026-12-01T00:00:00Z', [], now, 'UTC')).toBe(0)
    expect(sowDate(null, ['2026-11-15', null, '2026-11-12'], 'UTC')).toBe('2026-11-12')
  })

  it('counts on the unit\'s calendar: a new day starts at its midnight, not UTC\'s', () => {
    // Sown Monday 9 November in Los Angeles. Sunday 15th at 16:00 there is already the 16th in UTC, but still day 6.
    expect(daysSinceSowing(null, ['2026-11-09'], new Date('2026-11-16T00:00:00Z'), 'America/Los_Angeles')).toBe(6)
    // Day 7 is Monday the 16th from local midnight.
    expect(daysSinceSowing(null, ['2026-11-09'], new Date('2026-11-16T08:30:00Z'), 'America/Los_Angeles')).toBe(7)
    // A grow cycle started at local midnight in Tokyo is that day there, the day before in UTC.
    expect(sowDate('2026-11-08T15:00:00Z', [], 'Asia/Tokyo')).toBe('2026-11-09')
    expect(daysSinceSowing('2026-11-08T15:00:00Z', [], new Date('2026-11-09T14:59:00Z'), 'Asia/Tokyo')).toBe(0)
  })

  it('picks by stage, germination first for every crop, then fruiting whenever a fruiting crop is planted, saying why', () => {
    expect(recommendedPreset(0, ['herb'])).toEqual({ id: 'germination', why: 'day 0 since sowing' })
    // Day 7 is germination's second run; seedlings start on day 8.
    expect(recommendedPreset(7, [])?.id).toBe('germination')
    expect(recommendedPreset(8, [])).toEqual({ id: 'seedlings', why: 'day 8 since sowing' })
    expect(recommendedPreset(13, [])?.id).toBe('seedlings')
    expect(recommendedPreset(14, [])?.id).toBe('young')
    expect(recommendedPreset(21, [])?.id).toBe('young')
    expect(recommendedPreset(22, ['green'])).toEqual({ id: 'mature', why: 'day 22 since sowing' })
    expect(recommendedPreset(null, [])).toBeNull()
    expect(recommendedPreset(3, ['herb', 'fruiting'])?.id).toBe('germination')
    expect(recommendedPreset(7, ['herb', 'fruiting'])?.id).toBe('germination')
    expect(recommendedPreset(8, ['herb', 'fruiting'])).toEqual({ id: 'fruiting', why: 'a fruiting crop is planted' })
  })

  it('only ever moves forward: germination to anything after it, then seedlings, young, mature; fruiting only from germination', () => {
    expect(advances('germination', 'seedlings')).toBe(true)
    expect(advances('germination', 'fruiting')).toBe(true)
    expect(advances('germination', 'mature')).toBe(true)
    expect(advances('germination', 'germination')).toBe(false)
    expect(advances('seedlings', 'young')).toBe(true)
    expect(advances('young', 'mature')).toBe(true)
    expect(advances('mature', 'young')).toBe(false)
    expect(advances('seedlings', 'germination')).toBe(false)
    expect(advances('mature', 'germination')).toBe(false)
    expect(advances('fruiting', 'germination')).toBe(false)
    expect(advances('fruiting', 'mature')).toBe(false)
    expect(advances('seedlings', 'fruiting')).toBe(false)
    expect(recommendedPreset(null, ['fruiting'])?.id).toBe('fruiting')
  })

  it('finds the sowing weekday on the unit\'s calendar, from the same date as the days', () => {
    // 2026-11-12 is a Thursday; 07:00 UTC is still Wednesday evening in Los Angeles.
    expect(sowWeekday('2026-11-12T08:00:00Z', ['2026-11-09'], 'UTC', now)).toBe(3)
    expect(sowWeekday('2026-11-12T07:00:00Z', [], 'America/Los_Angeles', now)).toBe(2)
    // A plain sow date is that day anywhere; the earliest pod's.
    expect(sowWeekday(null, ['2026-11-12', null, '2026-11-09'], 'America/Los_Angeles', now)).toBe(0)
    // No date: today, Friday the 20th.
    expect(sowWeekday(undefined, [null], 'UTC', now)).toBe(4)
  })

  it('reads the planted plants\' catalog categories, skipping unknown names', () => {
    expect(plantCategories(['Cucumber', null, 'Not a plant', 'Basil'])).toEqual(['fruiting', expect.any(String)])
  })

  it('knows which preset the cycles are, and none when they differ', () => {
    const mature = presetSchedules(preset('mature'), { enabled: true, weekday: 0 })
    expect(appliedPreset(mature, null)).toBe('mature')
    expect(appliedPreset([{ id: 'water-seedlings-0800', spec: { minute: 480, durationS: 600 } }], null)).toBe('seedlings')
    // Under another id, its name still says which it is.
    expect(appliedPreset([{ id: 'water-old-0800', name: 'Seedlings · once a day 10 min (08:00)', spec: { minute: 480, durationS: 600 } }], null)).toBe('seedlings')
    expect(appliedPreset([{ id: 'other', name: 'Mine', spec: { minute: 480, durationS: 600 } }], null)).toBeNull()
    expect(appliedPreset(mature.slice(1), null)).toBeNull()
    expect(appliedPreset([{ ...mature[0] as typeof mature[number], spec: { minute: 480, durationS: 300 } }, ...mature.slice(1)], null)).toBeNull()
    expect(appliedPreset([], null)).toBeNull()
    expect(appliedPreset(presetSchedules(preset('germination'), { enabled: true, weekday: 5 }), null)).toBe('germination')
  })
})
