import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { boxesOff } from '../boxesOff'

const NOW = new Date('2026-11-16T12:00:00.000Z')

function unit() {
  const store = new MemoryStore()
  const dismissed = (slot: number, captureId: string, ts = '2026-11-15T10:00:00.000Z') => store.dismissals.dismiss({ captureId, ts, slot, dismissedAt: ts })
  return { store, dismissed }
}

describe('boxesOff', () => {
  it('names pods dismissed on two photos or more this week, on either camera', () => {
    const { store, dismissed } = unit()
    dismissed(28, 'lower-1')
    dismissed(28, 'lower-2')
    dismissed(28, 'lower-3')
    dismissed(3, 'upper-1')
    dismissed(3, 'upper-2')
    expect(boxesOff(store, NOW)).toEqual([
      { camera: 'upper', slot: 3, photos: 2 },
      { camera: 'lower', slot: 28, photos: 3 },
    ])
  })

  it('skips one dismissal, old ones, and boxes already moved or removed', () => {
    const { store, dismissed } = unit()
    // A neighbour's leaves over it once.
    dismissed(1, 'upper-1')
    // Over a week before.
    dismissed(2, 'upper-1', '2026-11-08T10:00:00.000Z')
    dismissed(2, 'upper-2', '2026-11-09T11:00:00.000Z')
    // Moved since, and removed since.
    for (const slot of [4, 27]) {
      dismissed(slot, `${slot}-a`)
      dismissed(slot, `${slot}-b`)
    }
    store.settings.update({ podRegions: { upper: { 4: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }, lower: { 27: null } } })
    expect(boxesOff(store, NOW)).toEqual([])
  })
})
