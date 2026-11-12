/**
 * Where the unit is, for light curves that follow the sun: the location the
 * owner set, or else its timezone's principal city (`zoneCoords.json`, from
 * the tz database's zone.tab via scripts/sync-zone-coords.mjs). A zone is a
 * city near enough to start from; a few hundred kilometres moves sunrise by
 * minutes.
 */
import ZONES from './zoneCoords.json'

export interface Place {
  latitude: number
  longitude: number
  /** `set` by the owner, or guessed from the `timezone`. */
  source: 'set' | 'timezone'
  /** The zone's city, for a guess: "Los Angeles". */
  city?: string
}

const COORDS: Record<string, number[]> = ZONES

/** A zone's own coordinates, under its name or the canonical name Intl gives an alias ("US/Pacific"). */
export function zoneCoords(timezone: string): [number, number] | null {
  let c = COORDS[timezone]
  if (!c) {
    try {
      c = COORDS[new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone]
    }
    catch {
      return null
    }
  }
  return c && c.length === 2 ? [c[0] as number, c[1] as number] : null
}

const cityOf = (timezone: string) => (timezone.split('/').at(-1) ?? timezone).replace(/_/g, ' ')

/** The unit's place for the sun; null with no location and a zone with no city (UTC). */
export function unitPlace(s: { latitude?: number | null, longitude?: number | null, timezone: string }): Place | null {
  if (s.latitude != null && s.longitude != null) return { latitude: s.latitude, longitude: s.longitude, source: 'set' }
  const z = zoneCoords(s.timezone)
  return z ? { latitude: z[0], longitude: z[1], source: 'timezone', city: cityOf(s.timezone) } : null
}
