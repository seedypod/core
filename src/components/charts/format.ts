/** Axis and readout labels for charts. */

export function fmtClock(minute: number): string {
  const h = Math.floor(minute / 60) % 24
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function fmtDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], { weekday: 'short', hour: '2-digit' })
}

export function fmtDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
