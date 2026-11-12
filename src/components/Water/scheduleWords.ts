/**
 * Your schedules (ADR-0030) in words and checks, shared by their list and
 * their editor on Water: what a set of cycles adds up to, how it compares
 * with another, and which cycles fall outside the light or past the pump's
 * limit.
 */
import { daysLabel } from '@/src/lib/days'
import { hhmm } from '@/src/scheduler/pumpPlan'

export interface Cycle { minute: number, durationS: number, days: number }
export type Light = { on: number, off: number } | null

const mins = (durationS: number) => Math.round(durationS / 60)
const bits = (mask: number) => [0, 1, 2, 3, 4, 5, 6].filter(d => mask & (1 << d)).length

/** The day mask every cycle shares, or null when they differ. */
export function sharedDays(cycles: readonly Cycle[]): number | null {
  const first = cycles[0]
  if (!first) return null
  return cycles.every(c => c.days === first.days) ? first.days : null
}

/** "every day", "weekdays", "Mondays", "Mon, Wed"; "on set days" when the cycles differ. */
export function daysWords(cycles: readonly Cycle[]): string {
  const days = sharedDays(cycles)
  if (days === null) return 'on set days'
  const label = daysLabel(days)
  return days === 127 || days === 31 || days === 96 ? label.toLowerCase() : label
}

/** "4 × 5 min", "3 × 5 / 8 min" with mixed lengths. */
export function runsWords(cycles: readonly Cycle[]): string {
  const lengths = [...new Set(cycles.map(c => mins(c.durationS)))]
  return `${cycles.length} × ${lengths.join(' / ')} min`
}

/** Minutes of watering in a week. */
export const weeklyMinutes = (cycles: readonly Cycle[]) => cycles.reduce((t, c) => t + mins(c.durationS) * bits(c.days), 0)

/** How much watering, as the editor's headline: "20 min" with "a day", "on Mondays" or "a week". */
export function amount(cycles: readonly Cycle[]): { minutes: number, per: string } {
  const days = sharedDays(cycles)
  if (days === null) return { minutes: weeklyMinutes(cycles), per: 'a week' }
  const minutes = cycles.reduce((t, c) => t + mins(c.durationS), 0)
  if (days === 127) return { minutes, per: 'a day' }
  return { minutes, per: `on ${daysWords(cycles)}` }
}

/**
 * Against where it started from: "Mature greens & herbs was 18 min a day, so
 * this is +2 min." By the day when both water every day, else by the week.
 */
export function comparedWith(name: string, before: readonly Cycle[], after: readonly Cycle[]): string {
  const daily = sharedDays(before) === 127 && sharedDays(after) === 127
  const was = daily ? amount(before).minutes : weeklyMinutes(before)
  const now = daily ? amount(after).minutes : weeklyMinutes(after)
  const per = daily ? 'a day' : 'a week'
  const diff = now - was
  if (diff === 0) return `Same as ${name}: ${was} min ${per}.`
  return `${name} was ${was} min ${per}, so this is ${diff > 0 ? '+' : '−'}${Math.abs(diff)} min${daily ? '' : ` ${per}`}.`
}

/** "06", or "06:30" off the hour, for the light band's label; the day's end is "24". */
export const hour = (minute: number) => (minute >= 1440 ? '24' : minute % 60 ? hhmm(minute) : hhmm(minute).slice(0, 2))

export interface OutOfLight {
  minute: number
  /** "22:30 is after lights off", "05:00 is before lights on", "20:58 runs past lights off". */
  why: string
  /** The nearest whole hour inside the light that no other cycle starts at; null if none. */
  moveTo: number | null
}

/**
 * Each cycle that starts before the light comes on or runs past it going
 * off, with a whole hour inside the light to move it to: the first one for a
 * run before lights on, the last one that ends by lights off for one after.
 */
export function outOfLight(cycles: readonly Cycle[], light: Light): OutOfLight[] {
  if (!light) return []
  const taken = new Set(cycles.map(c => c.minute))
  return cycles.flatMap((c) => {
    const len = Math.ceil(c.durationS / 60)
    const before = c.minute < light.on
    const after = c.minute >= light.off
    if (!before && !after && c.minute + len <= light.off) return []
    const fits = (m: number) => m >= light.on && m + len <= light.off && !taken.has(m)
    let moveTo: number | null = null
    if (before) {
      for (let m = Math.ceil(light.on / 60) * 60; m + len <= light.off; m += 60) {
        if (fits(m)) {
          moveTo = m
          break
        }
      }
    }
    else {
      for (let m = Math.floor((light.off - len) / 60) * 60; m >= light.on; m -= 60) {
        if (fits(m)) {
          moveTo = m
          break
        }
      }
    }
    const why = before ? `${hhmm(c.minute)} is before lights on` : after ? `${hhmm(c.minute)} is after lights off` : `${hhmm(c.minute)} runs past lights off`
    return [{ minute: c.minute, why, moveTo }]
  })
}

/** The cycles longer than the pump runs at a time, which it stops at the limit. */
export const overLimit = (cycles: readonly Cycle[], maxRunS: number) => cycles.filter(c => c.durationS > maxRunS)
