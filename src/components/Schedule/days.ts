/** Schedule day bitmask (Mon=1 … Sun=64) ⇄ DayPicker index list (0 = Mon). */
export function daysToList(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter(d => (mask & (1 << d)) !== 0)
}
export function listToDays(list: number[]): number {
  return list.reduce((m, d) => m | (1 << d), 0)
}
export function daysLabel(mask: number): string {
  if (mask === 127) return 'Every day'
  if (mask === 31) return 'Weekdays'
  if (mask === 96) return 'Weekends'
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return daysToList(mask).map(d => names[d]).join(' ') || 'Never'
}
