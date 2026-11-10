/**
 * The display units, from Settings → Unit's temperature choice: °C reads
 * metric (°C, L, cm) and °F reads US (°F, gal, in), because someone who
 * picks one wants the rest to match. Readings, settings and rules stay
 * metric underneath; only what's shown converts.
 */
export type UnitSystem = 'metric' | 'us'

let current: UnitSystem = 'metric'

/** Set from the settings at the app's root, which remounts the pages when it changes. */
export function setUnitSystem(system: UnitSystem): void {
  current = system
}

export const unitSystem = (): UnitSystem => current
export const systemFor = (temperatureUnit: 'C' | 'F' | undefined): UnitSystem => (temperatureUnit === 'F' ? 'us' : 'metric')

const round1 = (v: number) => Math.round(v * 10) / 10
const TO_US: Record<string, { unit: string, to: (v: number) => number, from: (v: number) => number }> = {
  '°C': { unit: '°F', to: v => v * 9 / 5 + 32, from: v => (v - 32) * 5 / 9 },
  'cm': { unit: 'in', to: v => v / 2.54, from: v => v * 2.54 },
  'L': { unit: 'gal', to: v => v / 3.785411784, from: v => v * 3.785411784 },
}

/** A stored metric value in the display units, to a decimal: 22.5 °C is 72.5 °F in US units. Other units pass through. */
export function toDisplay(value: number, unit: string, system: UnitSystem = current): { value: number, unit: string } {
  const c = system === 'us' ? TO_US[unit] : undefined
  return c ? { value: round1(c.to(value)), unit: c.unit } : { value, unit }
}

/** What someone typed in display units, back to the stored metric unit. */
export function fromDisplay(value: number, unit: string, system: UnitSystem = current): number {
  const c = system === 'us' ? TO_US[unit] : undefined
  return c ? c.from(value) : value
}

/** The unit a stored metric unit shows as. */
export const displayUnit = (unit: string, system: UnitSystem = current): string => toDisplay(0, unit, system).unit
