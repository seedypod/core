import { describe, expect, it } from 'vitest'
import { amount, comparedWith, daysWords, hour, outOfLight, overLimit, runsWords, sharedDays, weeklyMinutes } from '../scheduleWords'

const daily = (minute: number, min: number) => ({ minute, durationS: min * 60, days: 127 })
const summer = [daily(420, 5), daily(660, 5), daily(900, 5), daily(1350, 5)]
const mature = [daily(480, 6), daily(840, 6), daily(1200, 6)]
const light = { on: 360, off: 1260 }

describe('scheduleWords', () => {
  it('sums a schedule up: its runs, its days and how much a day', () => {
    expect(runsWords(summer)).toBe('4 × 5 min')
    expect(runsWords([daily(480, 5), daily(900, 8)])).toBe('2 × 5 / 8 min')
    expect(daysWords(summer)).toBe('every day')
    expect(daysWords([{ ...daily(480, 15), days: 1 }])).toBe('Mondays')
    expect(daysWords([{ ...daily(480, 15), days: 31 }])).toBe('weekdays')
    expect(daysWords([daily(480, 5), { ...daily(900, 5), days: 1 }])).toBe('on set days')
    expect(sharedDays([])).toBeNull()
    expect(amount(summer)).toEqual({ minutes: 20, per: 'a day' })
    expect(amount([{ ...daily(480, 15), days: 1 }])).toEqual({ minutes: 15, per: 'on Mondays' })
    expect(amount([daily(480, 5), { ...daily(900, 5), days: 1 }])).toEqual({ minutes: 40, per: 'a week' })
    expect(weeklyMinutes(mature)).toBe(126)
  })

  it('compares with where it started, by the day when both water daily, else by the week', () => {
    expect(comparedWith('Mature greens & herbs', mature, summer)).toBe('Mature greens & herbs was 18 min a day, so this is +2 min.')
    expect(comparedWith('Summer', summer, mature)).toBe('Summer was 20 min a day, so this is −2 min.')
    expect(comparedWith('Summer', summer, summer)).toBe('Same as Summer: 20 min a day.')
    expect(comparedWith('Germination', [{ ...daily(480, 15), days: 1 }], summer)).toBe('Germination was 15 min a week, so this is +125 min a week.')
  })

  it('finds the cycles outside the light, with a whole lit hour free to move each to', () => {
    expect(outOfLight(summer, null)).toEqual([])
    expect(outOfLight(summer, light)).toEqual([{ minute: 1350, why: '22:30 is after lights off', moveTo: 1200 }])
    // 20:00 is taken, so the hour before it.
    expect(outOfLight([...summer, daily(1200, 5)], light)).toEqual([{ minute: 1350, why: '22:30 is after lights off', moveTo: 1140 }])
    expect(outOfLight([daily(300, 5)], light)).toEqual([{ minute: 300, why: '05:00 is before lights on', moveTo: 360 }])
    expect(outOfLight([daily(1258, 5)], light)).toEqual([{ minute: 1258, why: '20:58 runs past lights off', moveTo: 1200 }])
    // No lit hour long enough: nowhere to move it.
    expect(outOfLight([daily(300, 15)], { on: 360, off: 370 })).toEqual([{ minute: 300, why: '05:00 is before lights on', moveTo: null }])
    expect(outOfLight([daily(1300, 15)], { on: 360, off: 370 })).toEqual([{ minute: 1300, why: '21:40 is after lights off', moveTo: null }])
  })

  it('names the light band\'s hours, and the runs past the pump\'s limit', () => {
    expect(hour(360)).toBe('06')
    expect(hour(390)).toBe('06:30')
    expect(hour(1440)).toBe('24')
    expect(overLimit([daily(480, 20), daily(900, 5)], 900)).toEqual([daily(480, 20)])
  })
})
