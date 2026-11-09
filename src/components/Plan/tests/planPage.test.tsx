// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanPage } from '../PlanPage'

// The hooks answer from the real planner, so the page renders real layouts and sowing dates.
const { state, calls, invalidate } = vi.hoisted(() => ({
  state: {
    pods: [] as { slot: number, plant: string | null, status: string }[],
    plans: [] as unknown[],
    applied: null as null | { seeded: number[], scheduled: { slot: number, plantName: string, sowOn: string }[] },
  },
  calls: { catalog: vi.fn(), layout: vi.fn(), save: vi.fn(), apply: vi.fn(), remove: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/utils/trpc', async () => {
  const { searchPlants } = await import('@/src/plants/catalog')
  const { planLayout, sowingPlan } = await import('@/src/plants/planner')
  const { MODELS, slots, zoneCounts } = await import('@/src/plants/zones')
  type Model = 'home' | 'studio'
  const mutation = (fn: (i: unknown) => void, data?: () => unknown) => ({
    useMutation: (o?: { onSuccess?: () => void }) => ({
      isPending: false,
      data: data?.(),
      mutate: (input: unknown) => {
        fn(input)
        o?.onSuccess?.()
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ planner: { invalidate, plans: { invalidate } }, grow: { invalidate } }),
      planner: {
        zones: { useQuery: ({ model }: { model: Model }) => ({ data: { ...MODELS[model], slots: slots(model), counts: zoneCounts(model) } }) },
        catalog: { useQuery: (i: { q?: string, category?: string }) => {
          calls.catalog(i)
          return { data: { plants: searchPlants(i as Parameters<typeof searchPlants>[0]).slice(0, 12) } }
        } },
        layout: { useQuery: (i: { model: Model, plants: { plantId: string, count: number }[] }) => {
          calls.layout(i)
          const occupied = Object.fromEntries(state.pods.filter(p => p.status !== 'empty').map(p => [p.slot, 'planted']))
          return { data: planLayout({ model: i.model, plants: i.plants, occupied }) }
        } },
        sowing: { useQuery: (i: { plants: { plantId: string, count: number }[], mode: 'staggered' | 'batch' }) => ({ data: sowingPlan(i.plants, new Date('2026-11-02T00:00:00Z'), i.mode) }) },
        plans: { useQuery: () => ({ data: state.plans }) },
        savePlan: mutation(calls.save),
        applyPlan: mutation(calls.apply, () => state.applied),
        removePlan: mutation(calls.remove),
      },
      grow: { pods: { useQuery: () => ({ data: state.pods }) } },
    },
  }
})

beforeEach(() => {
  state.pods = []
  state.plans = []
  state.applied = null
  for (const f of [...Object.values(calls), invalidate]) f.mockReset()
})
afterEach(cleanup)

const add = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Add ${name}` }))
const search = (q: string) => fireEvent.change(screen.getByLabelText('Search plants'), { target: { value: q } })

describe('PlanPage', () => {
  it('shows the tower’s zones, the catalog, and how to start', () => {
    render(<PlanPage />)
    expect(screen.getByText('High 12')).toBeTruthy()
    expect(screen.getByText('Medium 12')).toBeTruthy()
    expect(screen.getByText('Low 6')).toBeTruthy()
    expect(screen.getByText(/0 planned · 30 free/)).toBeTruthy()
    expect(screen.getByText(/Pick plants above, then save a plan/)).toBeTruthy()
    expect(screen.queryByText('Sowing schedule')).toBeNull()
  })

  it('switches to the Studio grid', () => {
    render(<PlanPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Studio · 16' }))
    expect(screen.getByText('High 5')).toBeTruthy()
    expect(screen.getByText('Low 2')).toBeTruthy()
  })

  it('filters the catalog by search and category', () => {
    render(<PlanPage />)
    search('basil')
    expect(calls.catalog).toHaveBeenLastCalledWith({ q: 'basil', category: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Herbs' }))
    expect(calls.catalog).toHaveBeenLastCalledWith({ q: 'basil', category: 'herb' })
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(calls.catalog).toHaveBeenLastCalledWith({ q: 'basil', category: undefined })
  })

  it('lays out picks by zone, staggers sowing, and saves the plan', () => {
    render(<PlanPage />)
    search('basil')
    add('Basil')
    add('Basil')
    expect(screen.getByText(/^2 planned/)).toBeTruthy()
    expect(calls.layout).toHaveBeenLastCalledWith({ model: 'home', plants: [{ plantId: 'basil', count: 2 }], respectExisting: true })
    // Two waves of basil: the second one notes its wave.
    expect(screen.getByText('wave 2')).toBeTruthy()
    expect(screen.getAllByText(/sow 2026-11-02 → harvest/)).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: 'All now' }))
    expect(screen.getAllByText(/sow 2026-11-02 → harvest/)).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Basil' }))
    expect(screen.getByText(/^1 planned/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Plan name'), { target: { value: 'Herbs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(calls.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Herbs', model: 'home', mode: 'batch', plants: [{ plantId: 'basil', count: 1 }] }))
    expect(invalidate).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByText('Sowing schedule')).toBeNull()
  })

  it('keeps planted pods, outlines fallbacks and reports what does not fit', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }, { slot: 2, plant: null, status: 'empty' }]
    render(<PlanPage />)
    expect(screen.getByText(/0 planned · 29 free/)).toBeTruthy()
    expect(screen.getByText('Mint')).toBeTruthy()
    search('jalapeño')
    for (let i = 0; i < 14; i++) add('Jalapeño')
    expect(screen.getByText(/Outlined pods sit one zone lower than ideal/)).toBeTruthy()
    search('mint')
    for (let i = 0; i < 6; i++) add('Mint')
    expect(screen.getByText('Didn’t fit: Mint — no free slot in the low zone (low 6/6 taken)')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Suggested moves' })).toBeNull()
    add('Mint')
    expect(screen.getByText('Didn’t fit: Mint ×2 — no free slot in the low zone (low 6/6 taken)')).toBeTruthy()
  })

  it('suggests moves that would make room', () => {
    render(<PlanPage />)
    search('jalapeño')
    for (let i = 0; i < 13; i++) add('Jalapeño')
    search('basil')
    for (let i = 0; i < 12; i++) add('Basil')
    expect(screen.getByText(/^Didn’t fit: Jalapeño — no free slot in the high or medium zones/)).toBeTruthy()
    const moves = within(screen.getByRole('list', { name: 'Suggested moves' })).getAllByRole('listitem').map(li => li.textContent)
    expect(moves[0]).toMatch(/^Move Basil from pod \d+ to pod \d+ \(low light, which it tolerates\) so Jalapeño can take pod \d+ \(medium\)\.$/)
    expect(moves[1]).toMatch(/^Allow Jalapeño in the low zone too/)
  })

  it('applies a saved plan only after confirming, and deletes one', () => {
    const layout = { model: 'home', assignments: [{ slot: 4 }, { slot: 5 }], unplaced: [], free: [] }
    state.plans = [
      { id: 'p1', name: 'Autumn', model: 'home', appliedAt: null, layout, request: [{ plantId: 'basil', count: 2 }] },
      { id: 'p2', name: 'Spring', model: 'home', appliedAt: '2026-10-01T00:00:00Z', layout, request: [{ plantId: 'kale', count: 2 }] },
    ]
    state.applied = { seeded: [4], scheduled: [{ slot: 5, plantName: 'Basil', sowOn: '2026-12-12' }] }
    render(<PlanPage />)
    expect(screen.getByText('applied')).toBeTruthy()
    expect(screen.getByText(/home · 2 pods · 2× basil/)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[0] as HTMLElement)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.apply).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[0] as HTMLElement)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }))
    expect(calls.apply).toHaveBeenCalledWith({ id: 'p1' })
    expect(screen.getByText('Applied: 1 pods seeded, 1 scheduled.')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete plan' })[1] as HTMLElement)
    expect(calls.remove).toHaveBeenCalledWith({ id: 'p2' })
  })
})
