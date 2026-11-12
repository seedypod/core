import { describe, expect, it } from 'vitest'
import { unitPlace, zoneCoords } from '../place'

describe('unitPlace', () => {
  it('takes the location the owner set over the timezone', () => {
    expect(unitPlace({ latitude: 37.77, longitude: -122.42, timezone: 'America/Los_Angeles' })).toEqual({ latitude: 37.77, longitude: -122.42, source: 'set' })
  })

  it('falls back on the timezone\'s city, by its name or an alias Intl knows', () => {
    expect(unitPlace({ latitude: null, longitude: null, timezone: 'America/Los_Angeles' })).toEqual({ latitude: 34.05, longitude: -118.24, source: 'timezone', city: 'Los Angeles' })
    expect(unitPlace({ timezone: 'America/St_Johns' })).toMatchObject({ city: 'St Johns', latitude: 47.57 })
    expect(zoneCoords('US/Pacific')).toEqual([34.05, -118.24])
    // Intl's old name for Kolkata.
    expect(zoneCoords('Asia/Calcutta')).toEqual(zoneCoords('Asia/Kolkata'))
  })

  it('has nowhere for UTC or a zone it can\'t read', () => {
    expect(unitPlace({ timezone: 'UTC' })).toBeNull()
    expect(unitPlace({ timezone: 'Not/AZone' })).toBeNull()
  })

  it('has a city for every zone the browser offers in Settings, bar UTC and Etc', () => {
    expect(Intl.supportedValuesOf('timeZone').filter(z => z !== 'UTC' && !z.startsWith('Etc/') && !zoneCoords(z))).toEqual([])
  })
})
