/** Timezone-aware local time helpers without a date library. */

export interface LocalTime {
  /** YYYY-MM-DD in the zone. */
  date: string
  /** Minutes past local midnight. */
  minute: number
  /** 0 = Monday … 6 = Sunday (matches the schedule bitmask). */
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

export function localTime(now: Date, timezone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(now)
  }
  catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(now)
  }
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minute: hour * 60 + Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

export function dayEnabled(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0
}

export function minuteToHHMM(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
