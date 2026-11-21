import { describe, expect, it } from 'vitest'
import { careNotes } from '../care'
import raw from '../care.json'
import { PLANTS } from '../catalog'

describe('careNotes', () => {
  it('has notes keyed by catalog id, and none for a page without them or an unknown plant', () => {
    expect(Object.keys(raw.plants).sort()).toEqual(PLANTS.map(p => p.id).sort())
    expect(careNotes('cucumber')?.prune).toMatch(/no more than 5 cucumbers/)
    expect(careNotes('white-petunia')).toBeNull()
    expect(careNotes('okra')).toBeNull()
  })
})
