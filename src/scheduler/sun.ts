/**
 * Sunrise and sunset without a library, and the light curve that follows
 * them. NOAA's solar equations (the "General Solar Position" sheet), good to
 * a minute or two, which is all a grow light needs.
 *
 * A curve that follows the sun keeps its setpoints like any other, so the
 * scheduler, charts and timeline read it unchanged; `followSun` rewrites them
 * each day from that day's sunrise and sunset, stretched or trimmed to the
 * curve's hours.
 */
import type { LightSetpoint, LightSpec, SunFollow } from '../store/types'
import type { SunHours } from './lightPlan'
import { unitPlace } from './place'
import { localTime } from './time'

const rad = Math.PI / 180
const deg = 180 / Math.PI

/** A day of sun at a place: minutes past local midnight. `day` is 0 in polar night and 1440 under the midnight sun. */
export interface SunDay { sunrise: number | null, sunset: number | null, noon: number, day: number }

/** The sun on local `date` (YYYY-MM-DD) at `lat`, `lon`, in `timezone`'s minutes. */
export function sunDay(date: string, lat: number, lon: number, timezone: string): SunDay {
  const [y, m, d] = date.split('-').map(Number)
  const midnightUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  // Julian centuries from J2000 at noon UTC on the date.
  const t = (midnightUtc / 86_400_000 + 2440587.5 + 0.5 - 2451545) / 36525
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const mean = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const centre = Math.sin(mean * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * mean * rad) * (0.019993 - 0.000101 * t) + Math.sin(3 * mean * rad) * 0.000289
  const omega = 125.04 - 1934.136 * t
  const lambda = l0 + centre - 0.00569 - 0.00478 * Math.sin(omega * rad)
  const eps = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega * rad)
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad))
  const yy = Math.tan((eps / 2) * rad) ** 2
  const eqTime = 4 * deg * (yy * Math.sin(2 * l0 * rad) - 2 * e * Math.sin(mean * rad) + 4 * e * yy * Math.sin(mean * rad) * Math.cos(2 * l0 * rad) - 0.5 * yy * yy * Math.sin(4 * l0 * rad) - 1.25 * e * e * Math.sin(2 * mean * rad))
  const noonUtc = 720 - 4 * lon - eqTime
  // The sun's centre 0.833° below the horizon: refraction and its radius.
  const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)
  const local = (utcMin: number) => localTime(new Date(midnightUtc + Math.round(utcMin) * 60_000), timezone).minute
  const noon = local(noonUtc)
  if (cosHa > 1) return { sunrise: null, sunset: null, noon, day: 0 }
  if (cosHa < -1) return { sunrise: null, sunset: null, noon, day: 1440 }
  const ha = 4 * deg * Math.acos(cosHa)
  return { sunrise: local(noonUtc - ha), sunset: local(noonUtc + ha), noon, day: Math.round(2 * ha) }
}

/** The day's light window: sunrise to sunset stretched or trimmed about midday to the curve's hours, then shifted. Minutes, `on` before `off`, either may pass midnight. */
export function sunWindow(sun: SunFollow, day: Pick<SunDay, 'noon' | 'day'>): { on: number, off: number } {
  const len = Math.min(sun.maxHours * 60, Math.max(sun.minHours * 60, day.day))
  const mid = day.noon + sun.shiftMin
  return { on: Math.round(mid - len / 2), off: Math.round(mid + len / 2) }
}

const wrap = (m: number) => ((m % 1440) + 1440) % 1440

/** Setpoints for a window, its sunrise and sunset ramps centred on `on` and `off` so it has `off - on` of full light. */
export function sunSetpoints(sun: SunFollow, w: { on: number, off: number }): LightSetpoint[] {
  const half = sun.rampMin / 2
  return [
    { minute: wrap(Math.round(w.on - half)), level: 0 },
    { minute: wrap(Math.round(w.on + half)), level: 100 },
    { minute: wrap(Math.round(w.off - half)), level: 100 },
    { minute: wrap(Math.round(w.off + half)), level: 0 },
  ]
}

/** Without a location or a zone to guess one from (UTC), the day is the curve's shortest, centred on 12:00. */
const NO_PLACE = { noon: 720, day: 0 }

/** A sun-following spec with its setpoints for the day of `now`, or the spec as it was when it doesn't follow the sun. An Auto curve takes its hours from `auto`. */
export function followSun(spec: LightSpec, place: { latitude: number | null, longitude: number | null, timezone: string }, now: Date, auto?: SunHours): LightSpec {
  if (!spec.sun) return spec
  const sun = spec.sun.auto && auto ? { ...spec.sun, minHours: auto.minHours, maxHours: auto.maxHours } : spec.sun
  const at = unitPlace(place)
  const here = at ? sunDay(localTime(now, place.timezone).date, at.latitude, at.longitude, place.timezone) : NO_PLACE
  return { ...spec, setpoints: sunSetpoints(sun, sunWindow(sun, here)) }
}

/** What a new sun-following curve starts from: 14–16 hours of full light, hour-long ramps, centred on midday. */
export const DEFAULT_SUN: SunFollow = { minHours: 14, maxHours: 16, rampMin: 60, shiftMin: 0 }

/** Auto: the sun, with its hours from the grow protocol. */
export const AUTO_SUN: SunFollow = { ...DEFAULT_SUN, auto: true }
