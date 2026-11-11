/** Schedule day bitmask (Mon=1 … Sun=64) ⇄ DayPicker index list (0 = Mon). */
export function daysToList(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter(d => (mask & (1 << d)) !== 0)
}
export function listToDays(list: number[]): number {
  return list.reduce((m, d) => m | (1 << d), 0)
}
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_PLURALS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays']

/** "Every day", "Weekdays", "Weekends", "Mondays" for one day, else "Mon, Wed, Fri"; "Never" with none. */
export function daysLabel(mask: number): string {
  if (mask === 127) return 'Every day'
  if (mask === 31) return 'Weekdays'
  if (mask === 96) return 'Weekends'
  const list = daysToList(mask)
  if (list.length === 1) return DAY_PLURALS[list[0] as number] as string
  return list.map(d => DAY_NAMES[d]).join(', ') || 'Never'
}

/** The days as a sentence's end, for a screen reader: "Runs every day", "Runs on Mondays", "Never runs". */
export function runsOn(mask: number): string {
  const label = daysLabel(mask)
  if (label === 'Never') return 'Never runs'
  return label === 'Every day' ? 'Runs every day' : `Runs on ${mask === 31 || mask === 96 ? label.toLowerCase() : label}`
}
/** Monday-first weekday of a local date (0 = Mon), the index the mask uses. */
export function weekdayOf(date: Date): number {
  return (date.getDay() + 6) % 7
}
export function dayOn(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0
}
