import type { Limits } from '@/src/hardware/contract'

/** hald's `water_low` detail when no trusted level reading came back: the sensor's problem, not the water's. */
export const UNREADABLE = 'water level sensor unavailable'

/**
 * Whether a low tank stops the pump: only while the tank-level guard runs
 * (`level` or `both`). On `current` the cutoff is a warning and the pump keeps
 * running on its current guard. A hald too old to say ran the level guard.
 */
export function lowStopsPump(limits: Pick<Limits, 'pumpDryGuard'> | null | undefined): boolean {
  return (limits?.pumpDryGuard ?? 'level') !== 'current'
}

/**
 * A `water_low` alert in words: a warning unless the tank read low and the
 * level guard runs, which is when the pump is off. `toast` is the snackbar's
 * title and detail.
 */
export function waterLowWords(detail: string, stops: boolean): { title: string, detail: string, urgent: boolean, toast: { title: string, detail: string } } {
  if (detail === UNREADABLE) {
    const why = stops ? ', so the level guard may stop the pump until it reads again.' : '. The pump keeps running on its current guard.'
    return { title: 'Tank level unreadable', detail: `No trusted tank reading came back${why}`, urgent: false, toast: { title: 'Tank level unreadable', detail: stops ? 'The pump may stop until it reads again.' : 'The pump keeps running on its current guard.' } }
  }
  if (stops) return { title: 'Water low', detail, urgent: true, toast: { title: 'Pump off: water low', detail: 'It stays off until the tank is filled.' } }
  const note = 'The pump keeps running: its current guard stops it if it runs dry.'
  return { title: 'Water low', detail: detail ? `${detail}. ${note}` : note, urgent: false, toast: { title: 'Tank reads low', detail: 'The pump keeps running on its current guard. Top off the tank.' } }
}
