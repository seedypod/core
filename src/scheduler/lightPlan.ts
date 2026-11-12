/**
 * Gardyn's light guidance, shared by the Light page and MCP so both rate a curve
 * the same way. From Gardyn's help centre ("Understanding the Lighting
 * Schedule"): aim for 14–16 hours a day of Boost, the light at full
 * brightness; 17 or more stress the plants (bitter leaves, bolting, pale
 * spots); and each night needs unbroken dark. Their ratings run Low, Ok,
 * Great, Intense, Too much.
 *
 * Gardyn says dimmed hours don't count; here they count in part, since a
 * plant takes in light in proportion to it: two hours at 50% are one hour of
 * full light. How long the light is on at all is a separate check, since a
 * long day, even a dim one, can make lettuce and herbs bolt.
 */
import type { LightSpec } from '../store/types'
import { lightLevelAt } from './scheduler'

export const GARDYN_LIGHT_GUIDE = 'https://help.mygardyn.com/en/articles/1776193#managing_light'

/** At or near full brightness: what Gardyn calls Boost. */
export const BOOST_LEVEL = 95

export type LightRating = 'low' | 'ok' | 'great' | 'intense' | 'too much'

/** On longer than this a day, even dimmed, lettuce and herbs may bolt. */
export const LONG_DAY_HOURS = 17

/** A day of light: `full` hours of it at full brightness, dimmed hours counted in part, and `lit` hours on at all. */
export interface LightDay { full: number, lit: number }

/** The day from the light's level at each minute, both to the half hour. */
export function lightDay(levelAt: (minute: number) => number): LightDay {
  let full = 0
  let lit = 0
  for (let m = 0; m < 1440; m++) {
    const level = levelAt(m)
    full += level / 100
    if (level > 0) lit++
  }
  return { full: Math.round(full / 30) / 2, lit: Math.round(lit / 30) / 2 }
}

export const lightHours = (spec: LightSpec): LightDay => lightDay(m => lightLevelAt(spec, m) ?? 0)

/** Gardyn's rating for a day's hours of full light: 14–16 is Great, 17 or more Too much. */
export function lightRating(hours: number): LightRating {
  if (hours < 12) return 'low'
  if (hours < 14) return 'ok'
  if (hours <= 16) return 'great'
  if (hours < 17) return 'intense'
  return 'too much'
}

export interface LightPreset { id: string, name: string, description: string, setpoints: { minute: number, level: number }[] }

/**
 * A day of light from `on` to `off` (minutes), with a sunrise and sunset of
 * `ramp` minutes centred on each, so the day has `off - on` hours of full
 * light as dimmed hours count.
 */
const day = (on: number, off: number, ramp = 30) => [{ minute: on - ramp / 2, level: 0 }, { minute: on + ramp / 2, level: 100 }, { minute: off - ramp / 2, level: 100 }, { minute: off + ramp / 2, level: 0 }]

export const LIGHT_PRESETS: LightPreset[] = [
  { id: 'day-15h', name: 'Gardyn day · 15 h', description: 'Light 6 AM to 9 PM, with a half-hour sunrise and sunset: the middle of Gardyn’s 14–16 hours.', setpoints: day(360, 1260) },
  { id: 'day-14h', name: 'Short day · 14 h', description: 'Light 6 AM to 8 PM: the low end of Gardyn’s range, for a room that’s lit in the evening.', setpoints: day(360, 1200) },
  { id: 'day-16h', name: 'Long day · 16 h', description: 'Light 6 AM to 10 PM: the most Gardyn recommends before plants stress and bolt.', setpoints: day(360, 1320) },
  { id: 'gentle-14h', name: 'Gentle day · 14 h', description: 'A two-hour sunrise from 6 AM and sunset to 10 PM, full from 8 AM to 8 PM: 14 hours of full light, with less glare at either end.', setpoints: day(420, 1260, 120) },
]
