import { describe, expect, it } from 'vitest'
import { pumpFault } from '../pumpFault'

describe('pumpFault', () => {
  it('splits the current guard\'s fault into the dry-run and what the pump drew', () => {
    const why = { reason: 'dry-run', detail: 'Pump drew 0.4 A, below 1.2 A for 5 s: it\'s pulling air' }
    expect(pumpFault('dry-run: pump drew 0.4 A, below 1.2 A for 5 s: it\'s pulling air')).toEqual(why)
    // As the alert carries it.
    expect(pumpFault('pump: dry-run: pump drew 0.4 A, below 1.2 A for 5 s: it\'s pulling air')).toEqual(why)
  })

  it('leaves a fault with nothing more to say as it is', () => {
    expect(pumpFault('dry-run')).toEqual({ reason: 'dry-run', detail: null })
    expect(pumpFault('pump: over-temp')).toEqual({ reason: 'over-temp', detail: null })
    expect(pumpFault('pump stopped: tank ran dry')).toEqual({ reason: 'tank ran dry', detail: null })
    expect(pumpFault('')).toEqual({ reason: 'fault', detail: null })
  })
})
