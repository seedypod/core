/**
 * A pump fault as hald words it, split into what tripped and why. The level
 * guard says `dry-run`; the current guard (#220) says what the pump drew:
 * `dry-run: pump drew 0.4 A, below 1.2 A for 5 s: it's pulling air`. Alerts
 * carry it as `pump: <fault>`, and the sim's as `pump stopped: <why>`.
 */
export function pumpFault(text: string): { reason: string, detail: string | null } {
  const fault = text.replace(/^pump(?: stopped)?:\s*/i, '').trim()
  const at = fault.indexOf(': ')
  if (at < 0) return { reason: fault || 'fault', detail: null }
  const why = fault.slice(at + 2).trim()
  return { reason: fault.slice(0, at), detail: why[0].toUpperCase() + why.slice(1) }
}
