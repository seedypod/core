import { describe, expect, it } from 'vitest'
import { fmtStamp, secondsAgo, timeAgo } from '../timeAgo'

const now = Date.parse('2026-11-01T12:00:00Z')

describe('secondsAgo', () => {
  it('counts seconds, then minutes, then hours', () => {
    expect(secondsAgo(now - 8_000, now)).toBe('8s ago')
    expect(secondsAgo(now - 59_999, now)).toBe('59s ago')
    expect(secondsAgo(now - 60_000, now)).toBe('1m ago')
    expect(secondsAgo(now - 3_600_000, now)).toBe('1h ago')
  })

  it('reads a time ahead of now as this instant', () => {
    expect(secondsAgo(now + 5_000, now)).toBe('0s ago')
  })
})

describe('timeAgo', () => {
  it('rounds down to minutes, hours, then days', () => {
    expect(timeAgo('2026-11-01T11:59:40Z', now)).toBe('just now')
    expect(timeAgo('2026-11-01T11:48:00Z', now)).toBe('12 min ago')
    expect(timeAgo('2026-11-01T08:00:00Z', now)).toBe('4 h ago')
    expect(timeAgo('2026-10-30T13:00:00Z', now)).toBe('47 h ago')
    expect(timeAgo('2026-10-29T12:00:00Z', now)).toBe('3 d ago')
  })

  it('treats a time ahead of the clock as now', () => {
    expect(timeAgo('2026-11-01T12:05:00Z', now)).toBe('just now')
  })
})

describe('fmtStamp', () => {
  it('gives the day, month and clock time', () => {
    const s = fmtStamp('2026-10-31T17:50:00')
    expect(s).toMatch(/31/)
    expect(s).toMatch(/Oct/)
    expect(s).toMatch(/50/)
  })
})
