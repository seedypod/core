// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { careRows, PlantCare, thinText } from '../PlantCare'

const state: { data: unknown } = { data: undefined }
vi.mock('@/src/utils/trpc', () => ({ trpc: { planner: { care: { useQuery: () => ({ data: state.data }) } } } }))

const care = (o: Record<string, unknown> = {}) => ({
  plant: { id: 'basil', name: 'Basil' }, thinTo: 3, thinEstimated: false, sproutDays: [5, 21], sproutEstimated: false, maturityDays: [68, 68], heightFt: '<1', tempF: [70, 85],
  fullDose: 'leavesOrRoots', latinName: 'Ocimum basilicum', url: 'https://help.mygardyn.com/en/articles/1783873', notes: { harvest: 'Cut above the nodes.', health: 'Watch for aphids.' }, ...o,
}) as Parameters<typeof careRows>[0]

beforeEach(() => {
  state.data = undefined
})
afterEach(cleanup)

describe('PlantCare', () => {
  it('words the thinning count, marking a rule for the kind', () => {
    expect([thinText({ thinTo: 3, thinEstimated: false }), thinText({ thinTo: 1, thinEstimated: true }), thinText({ thinTo: 'all', thinEstimated: false })]).toEqual(['Keep 3 sprouts', '~Keep 1 sprout', 'Don’t thin'])
  })

  it('lists only the facts Gardyn gives', () => {
    expect(careRows(care())).toEqual([['Thinning', 'Keep 3 sprouts'], ['Sprouts in', '5–21 days'], ['Matures in', '68 days'], ['Height', '<1 ft'], ['Temperature', '70–85 °F']])
    expect(careRows(care({ sproutDays: null, maturityDays: null, heightFt: null, tempF: null })).map(r => r[0])).toEqual(['Thinning'])
  })

  it('shows the facts, the notes and Gardyn\'s page, and nothing before the plant loads', () => {
    const { container, rerender } = render(<PlantCare plant="Basil" />)
    expect(container.innerHTML).toBe('')
    state.data = care()
    rerender(<PlantCare plant="Basil" />)
    expect(screen.getByText('Keep 3 sprouts')).toBeTruthy()
    expect(screen.getByText('PESTS')).toBeTruthy()
    expect(screen.getByText('Cut above the nodes.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Gardyn’s page' }).getAttribute('href')).toBe('https://help.mygardyn.com/en/articles/1783873')
    state.data = care({ notes: null, url: null })
    rerender(<PlantCare plant="Basil" />)
    expect(screen.queryByText('Care and harvest')).toBeNull()
  })
})
