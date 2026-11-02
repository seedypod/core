import { describe, expect, it } from 'vitest'
import { dayOn, daysLabel, daysToList, listToDays, weekdayOf } from '../days'

describe('schedule days', () => {
  it('round-trips the mask through the picker list', () => {
    expect(daysToList(0b1000001)).toEqual([0, 6])
    expect(listToDays([0, 6])).toBe(0b1000001)
    expect(daysLabel(127)).toBe('Every day')
    expect(daysLabel(0b101)).toBe('Mon Wed')
  })

  it('reads a local date Monday-first, as the mask does', () => {
    expect(weekdayOf(new Date(2026, 10, 2))).toBe(0)
    expect(weekdayOf(new Date(2026, 10, 1))).toBe(6)
    expect(dayOn(0b1000000, 6)).toBe(true)
    expect(dayOn(0b1000000, 0)).toBe(false)
  })
})
