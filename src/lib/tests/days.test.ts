import { describe, expect, it } from 'vitest'
import { dayOn, daysLabel, daysToList, listToDays, runsOn, weekdayOf } from '../days'

describe('schedule days', () => {
  it('round-trips the mask through the picker list', () => {
    expect(daysToList(0b1000001)).toEqual([0, 6])
    expect(listToDays([0, 6])).toBe(0b1000001)
    expect(daysLabel(127)).toBe('Every day')
  })

  it('sums the days up: every day, weekdays, weekends, one day by name, else a list', () => {
    expect(daysLabel(31)).toBe('Weekdays')
    expect(daysLabel(96)).toBe('Weekends')
    expect(daysLabel(1)).toBe('Mondays')
    expect(daysLabel(64)).toBe('Sundays')
    expect(daysLabel(0b10101)).toBe('Mon, Wed, Fri')
    expect(daysLabel(0)).toBe('Never')
    expect(runsOn(127)).toBe('Runs every day')
    expect(runsOn(31)).toBe('Runs on weekdays')
    expect(runsOn(1)).toBe('Runs on Mondays')
    expect(runsOn(0b101)).toBe('Runs on Mon, Wed')
    expect(runsOn(0)).toBe('Never runs')
  })

  it('reads a local date Monday-first, as the mask does', () => {
    expect(weekdayOf(new Date(2026, 10, 2))).toBe(0)
    expect(weekdayOf(new Date(2026, 10, 1))).toBe(6)
    expect(dayOn(0b1000000, 6)).toBe(true)
    expect(dayOn(0b1000000, 0)).toBe(false)
  })
})
