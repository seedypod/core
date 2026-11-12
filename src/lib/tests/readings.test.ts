import { describe, expect, it } from 'vitest'
import { isOlder, newestReadings } from '../readings'

const at = (ts: string, value = 1) => ({ ts, value, unit: '°C', quality: 'good' as const })

describe('isOlder', () => {
  it('compares instants, not strings', () => {
    // 10:00 at +02:00 is 08:00 UTC, though it sorts after 09:00Z.
    expect(isOlder(at('2026-11-06T10:00:00+02:00'), at('2026-11-06T09:00:00Z'))).toBe(true)
    expect(isOlder(at('2026-11-06T09:00:00Z'), at('2026-11-06T10:00:00+02:00'))).toBe(false)
  })

  it('has nothing to be older than without a reading, and ties go to the newcomer', () => {
    expect(isOlder(at('2026-11-06T09:00:00Z'), undefined)).toBe(false)
    expect(isOlder(at('2026-11-06T09:00:00Z'), at('2026-11-06T09:00:00Z'))).toBe(false)
  })
})

describe('newestReadings', () => {
  const old = at('2026-11-06T10:00:00Z', 20)
  const late = at('2026-11-06T10:00:10Z', 21)

  it('takes everything on the first fetch', () => {
    expect(newestReadings(undefined, { air_temp: old })).toEqual({ air_temp: old })
  })

  it('takes a newer reading and keeps a held one over an older', () => {
    expect(newestReadings({ air_temp: old }, { air_temp: late })).toEqual({ air_temp: late })
    expect(newestReadings({ air_temp: late }, { air_temp: old })).toEqual({ air_temp: late })
  })

  it('decides per sensor', () => {
    expect(newestReadings({ air_temp: late, humidity: old }, { air_temp: old, humidity: late })).toEqual({ air_temp: late, humidity: late })
  })

  it('drops a sensor the server no longer reports and adds a new one', () => {
    expect(newestReadings({ air_temp: late, ph: old }, { air_temp: late, ec: old })).toEqual({ air_temp: late, ec: old })
  })

  it('returns the same object when nothing changed, so nothing re-renders', () => {
    const held = { air_temp: late }
    expect(newestReadings(held, { air_temp: { ...late } })).toBe(held)
  })
})
