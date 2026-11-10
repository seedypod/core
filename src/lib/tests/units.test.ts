import { afterEach, describe, expect, it } from 'vitest'
import { withUnit } from '../sensorMeta'
import { displayUnit, fromDisplay, setUnitSystem, systemFor, toDisplay } from '../units'

afterEach(() => setUnitSystem('metric'))

describe('display units', () => {
  it('follows the temperature choice: °F means US units throughout', () => {
    expect(systemFor('F')).toBe('us')
    expect(systemFor('C')).toBe('metric')
    expect(systemFor(undefined)).toBe('metric')
  })

  it('converts °C, cm and L to °F, in and gal, to a decimal, and leaves the rest', () => {
    expect(toDisplay(22.5, '°C', 'us')).toEqual({ value: 72.5, unit: '°F' })
    expect(toDisplay(12.7, 'cm', 'us')).toEqual({ value: 5, unit: 'in' })
    expect(toDisplay(19, 'L', 'us')).toEqual({ value: 5, unit: 'gal' })
    expect(toDisplay(53, '%', 'us')).toEqual({ value: 53, unit: '%' })
    expect(toDisplay(22.5, '°C', 'metric')).toEqual({ value: 22.5, unit: '°C' })
    expect(displayUnit('cm', 'us')).toBe('in')
  })

  it('takes a typed display value back to the stored unit', () => {
    expect(fromDisplay(72.5, '°C', 'us')).toBeCloseTo(22.5)
    expect(fromDisplay(2.5, 'cm', 'us')).toBeCloseTo(6.35)
    expect(fromDisplay(5, 'L', 'us')).toBeCloseTo(18.93, 2)
    expect(fromDisplay(5, 'L', 'metric')).toBe(5)
  })

  it('is what every reading shows once the app sets it', () => {
    expect(withUnit(26.2, '°C')).toBe('26.2°C')
    setUnitSystem('us')
    expect(withUnit(26.2, '°C')).toBe('79.2°F')
    expect(withUnit(12.7, 'cm')).toBe('5 in')
    expect(withUnit(53, '%')).toBe('53%')
    // Already-formatted text isn't converted.
    expect(withUnit('—', '°C')).toBe('—°C')
  })
})
