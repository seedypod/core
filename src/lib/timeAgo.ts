/** `just now`, `12 min ago`, `4 h ago`, `3 d ago`: how long before `now` an ISO time was. */
export function timeAgo(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`
  return `${Math.floor(min / 1440)} d ago`
}

/** `8s ago`, `3m ago`, `2h ago`: how long before `now` a reading was taken, for ages that tick. */
export function secondsAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

/** A capture or alert time as day, month and clock (`31 Oct 17:50` in en-GB). */
export function fmtStamp(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
