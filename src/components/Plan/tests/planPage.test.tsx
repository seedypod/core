// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodState } from '@/src/components/Grow/towerScene'
import { PlanPage, VIEW_KEY } from '../PlanPage'
import { UNDO_MS } from '../SavedPlans'

// The 3D view is covered by towerView.test.tsx and the browser tests; here it reports what it was given.
const { tower } = vi.hoisted(() => ({ tower: { props: null as null | Record<string, unknown>, unavailable: false } }))
vi.mock('@/src/components/Grow/TowerView', () => ({
  TowerView: (props: Record<string, unknown>) => {
    tower.props = props
    if (tower.unavailable) queueMicrotask(() => (props.onUnavailable as () => void)())
    return <div data-testid="tower" />
  },
}))

// The hooks answer from the real planner, so the page renders real layouts and sowing dates.
const { state, calls, invalidate } = vi.hoisted(() => ({
  state: {
    pods: [] as { slot: number, plant: string | null, status: string }[],
    plans: [] as unknown[],
    applied: null as null | { seeded: number[], scheduled: { slot: number, plantName: string, sowOn: string }[] },
    custom: [] as unknown[],
  },
  calls: { catalog: vi.fn(), layout: vi.fn(), save: vi.fn(), apply: vi.fn(), remove: vi.fn(), addPlant: vi.fn(), updatePlant: vi.fn(), removePlant: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/utils/trpc', async () => {
  const { searchPlants } = await import('@/src/plants/catalog')
  const { planLayout, sowingPlan } = await import('@/src/plants/planner')
  const { MODELS, slots, zoneCounts } = await import('@/src/plants/zones')
  type Model = 'home' | 'studio'
  type PlanOverrides = Parameters<typeof planLayout>[0]['overrides']
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
          return { data: { plants: [...searchPlants(i as Parameters<typeof searchPlants>[0]).slice(0, 12), ...state.custom] } }
        } },
        layout: { useQuery: (i: { model: Model, plants: { plantId: string, count: number }[], overrides?: PlanOverrides }) => {
          calls.layout(i)
          const occupied = Object.fromEntries(state.pods.filter(p => p.status !== 'empty').map(p => [p.slot, 'planted']))
          return { data: planLayout({ model: i.model, plants: i.plants, occupied, overrides: i.overrides }) }
        } },
        sowing: { useQuery: (i: { plants: { plantId: string, count: number }[], mode: 'staggered' | 'batch', start?: string }) => ({ data: sowingPlan(i.plants, new Date(i.start ?? '2026-11-02T00:00:00Z'), i.mode) }) },
        plans: { useQuery: () => ({ data: state.plans }) },
        savePlan: mutation(calls.save),
        applyPlan: mutation(calls.apply, () => state.applied),
        removePlan: mutation(calls.remove),
        addPlant: mutation(calls.addPlant),
        updatePlant: mutation(calls.updatePlant),
        removePlant: mutation(calls.removePlant),
      },
      grow: { pods: { useQuery: () => ({ data: state.pods }) } },
    },
  }
})

beforeEach(() => {
  state.pods = []
  state.plans = []
  state.applied = null
  state.custom = []
  for (const f of [...Object.values(calls), invalidate]) f.mockReset()
  tower.props = null
  tower.unavailable = false
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const add = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Add ${name}` }))
const search = (q: string) => fireEvent.change(screen.getByLabelText('Search plants'), { target: { value: q } })
const flat = () => fireEvent.click(screen.getByRole('tab', { name: '2D' }))
const towerPods = () => tower.props?.pods as PodState[]

describe('PlanPage', () => {
  it('shows the tower’s zones, the catalog, and how to start', () => {
    render(<PlanPage />)
    expect(screen.getByText('High 12')).toBeTruthy()
    expect(screen.getByText('Medium 12')).toBeTruthy()
    expect(screen.getByText('Low 6')).toBeTruthy()
    expect(screen.getByText(/0 planned · 30 empty/)).toBeTruthy()
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
    flat()
    expect(screen.getByText(/0 planned · 29 empty/)).toBeTruthy()
    expect(screen.getByText('Mint')).toBeTruthy()
    search('jalapeño')
    for (let i = 0; i < 14; i++) add('Jalapeño')
    expect(screen.getByText(/Outlined pods sit one zone lower than ideal/)).toBeTruthy()
    search('mint')
    for (let i = 0; i < 6; i++) add('Mint')
    expect(screen.getByText('Didn’t fit: Mint — no free slot in the low zone (low 6/6 taken)')).toBeTruthy()
    // Medium still has room, and a herb takes the extra light.
    expect(screen.getByRole('list', { name: 'Suggested moves' }).textContent).toBe('Allow Mint in the medium zone too (10 free) — more light than its ideal low zone, which herbs tolerate.')
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

  it('lists saved plans by plant name, applies one only after confirming, and deletes one with an undo', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const layout = { model: 'home', assignments: [{ slot: 4, plantId: 'basil', plantName: 'Basil' }, { slot: 5, plantId: 'basil', plantName: 'Basil' }], unplaced: [], free: [] }
    state.plans = [
      { id: 'p1', name: 'Autumn', model: 'home', appliedAt: null, layout, request: [{ plantId: 'basil', count: 2 }], sowing: [] },
      { id: 'p2', name: 'Spring', model: 'home', appliedAt: '2026-10-01T00:00:00Z', layout: { ...layout, assignments: [] }, request: [{ plantId: 'italian-parsley', count: 1 }], sowing: [] },
    ]
    state.applied = { seeded: [4], scheduled: [{ slot: 5, plantName: 'Basil', sowOn: '2026-12-12' }] }
    render(<PlanPage />)
    expect(screen.getByText('applied')).toBeTruthy()
    const autumn = within(screen.getByRole('group', { name: 'Autumn' }))
    expect(autumn.getByTestId('plan-meta').textContent).toBe('Gardyn Home·2 of 30 pods')
    expect(autumn.getByRole('list', { name: 'Plants in Autumn' }).textContent).toBe('Basil×2')
    expect(within(screen.getByRole('group', { name: 'Spring' })).getByRole('list').textContent).toBe('Italian Parsley')

    fireEvent.click(autumn.getByRole('button', { name: 'Apply to tower' }))
    expect(within(screen.getByRole('dialog')).getByText('2 pods marked seeded today.')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.apply).not.toHaveBeenCalled()

    fireEvent.click(autumn.getByRole('button', { name: 'Apply to tower' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply to tower' }))
    expect(calls.apply).toHaveBeenCalledWith({ id: 'p1' })
    expect(screen.getByText('Applied: 1 pods seeded, 1 scheduled.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Spring' }))
    expect(screen.queryByRole('group', { name: 'Spring' })).toBeNull()
    expect(screen.getByText('Deleted “Spring”')).toBeTruthy()
    act(() => vi.advanceTimersByTime(UNDO_MS))
    expect(calls.remove).toHaveBeenCalledWith({ id: 'p2' })
    vi.useRealTimers()
  })

  it('adds a plant of your own and edits or deletes one', () => {
    state.custom = [{ id: 'okra', name: 'Okra', category: 'fruiting', zone: 'high', harvestMonths: [2, 3], harvestEstimated: false, careLevel: null, size: 'large', inStore: false, custom: true }]
    render(<PlanPage />)
    expect(screen.getByText('(yours)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit Basil' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add plant' }))
    const add = within(screen.getByRole('dialog'))
    expect(add.getByText('Add a plant')).toBeTruthy()
    fireEvent.change(add.getByLabelText('Name'), { target: { value: 'Lovage' } })
    fireEvent.click(add.getByRole('tab', { name: 'Low' }))
    fireEvent.click(add.getByRole('button', { name: 'Add' }))
    expect(calls.addPlant).toHaveBeenCalledWith({ name: 'Lovage', category: 'herb', zone: 'low', harvestMonths: [2, 3], careLevel: null, size: 'normal' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Okra' }))
    const edit = within(screen.getByRole('dialog'))
    expect((edit.getByLabelText('Name') as HTMLInputElement).value).toBe('Okra')
    fireEvent.click(edit.getByRole('button', { name: 'Delete' }))
    expect(calls.removePlant).toHaveBeenCalledWith({ id: 'okra' })
  })

  it('counts the pods a plan leaves empty, not the pods unplanted today', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }]
    render(<PlanPage />)
    search('basil')
    for (let i = 0; i < 20; i++) add('Basil')
    // 17 basil fit (medium 12, then the 5 low pods mint leaves); the 12 high pods stay empty, not the 29 unplanted today.
    expect(towerPods().filter(p => p.planned)).toHaveLength(17)
    expect(screen.getByText(/^20 planned · 12 empty ·/)).toBeTruthy()
  })

  it('tells pods placed in a higher zone apart from ones placed lower', () => {
    // An agent's plan: seven oregano with the medium zone allowed, so one sits higher than its ideal low.
    const overrides = { allowedZones: { oregano: ['low', 'medium'] as ('low' | 'medium')[] } }
    state.plans = [{ id: 'mcp-2', name: 'Herbs', model: 'home', mode: 'staggered', appliedAt: null, start: null, layout: { model: 'home', assignments: [], unplaced: [], free: [], overrides }, request: [{ plantId: 'oregano', count: 7 }] }]
    render(<PlanPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in planner' }))
    expect(screen.getByText(/click one for why it sits there\. Some sit higher than ideal, in more light, in a zone allowed for them\.$/)).toBeTruthy()
    expect(screen.queryByText(/lower than ideal/)).toBeNull()
    expect(towerPods().filter(p => p.harvest?.reason === 'Planned: medium zone, allowed by the caller (ideal low).')).toHaveLength(1)
    flat()
    expect(screen.getByText(/^Italic = already planted\. Dashed outlines sit higher than ideal/)).toBeTruthy()
    expect(screen.queryByText(/lower than ideal/)).toBeNull()
    const higher = screen.getByTitle('medium zone, allowed by the caller (ideal low)')
    expect(higher.className).toContain('outline-dashed')
    expect(higher.className).not.toContain('outline-[var(--status-warn)]')
    expect(screen.getAllByTitle('low light zone').every(e => !e.className.includes('outline'))).toBe(true)
  })

  it('opens a saved plan (e.g. one an agent saved) with its layout, overrides and schedule, and updates it in place', () => {
    const overrides = { pins: [{ slot: 4, plantId: 'basil' }] }
    state.plans = [{ id: 'mcp-1', name: 'Gardyn order', model: 'studio', mode: 'staggered', appliedAt: null, start: '2026-10-01', layout: { model: 'studio', assignments: [{ slot: 4 }, { slot: 7 }], unplaced: [], free: [], overrides }, request: [{ plantId: 'basil', count: 2 }] }]
    render(<PlanPage />)
    flat()
    fireEvent.click(screen.getByRole('button', { name: 'Open in planner' }))
    expect(screen.getByText('editing')).toBeTruthy()
    expect(calls.layout).toHaveBeenLastCalledWith({ model: 'studio', plants: [{ plantId: 'basil', count: 2 }], respectExisting: true, overrides })
    expect(screen.getByText('High 5')).toBeTruthy()
    expect((screen.getByLabelText('Plan name') as HTMLInputElement).value).toBe('Gardyn order')
    expect(screen.getAllByText(/sow 2026-10-01 → harvest/)).toHaveLength(1)
    expect(screen.getByTitle(/^pinned to pod 4 by the caller/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Update plan' }))
    expect(calls.save).toHaveBeenCalledWith({ id: 'mcp-1', name: 'Gardyn order', model: 'studio', mode: 'staggered', plants: [{ plantId: 'basil', count: 2 }], start: '2026-10-01', overrides })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    add('Basil')
    expect(calls.layout).toHaveBeenLastCalledWith({ model: 'studio', plants: [{ plantId: 'basil', count: 1 }], respectExisting: true })
    expect(screen.getByRole('button', { name: 'Save plan' })).toBeTruthy()
  })

  it('opens on the 3D tower, lit and coloured by zone, with the grid’s slots', () => {
    render(<PlanPage />)
    expect(screen.getByRole('tab', { name: '3D' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('tower')).toBeTruthy()
    expect(screen.queryByTestId('plan-grid')).toBeNull()
    expect(tower.props).toMatchObject({ zones: true, lightLevel: 100, waterPct: null, selected: null })
    expect(towerPods().map(p => p.slot)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(screen.getByText('High 12')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Studio · 16' }))
    expect(towerPods()).toHaveLength(16)
    flat()
    expect(screen.getByTestId('plan-grid').children).toHaveLength(16)
  })

  it('shows planned, planted and empty pods on the tower, and what did not fit', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }]
    render(<PlanPage />)
    search('jalapeño')
    for (let i = 0; i < 14; i++) add('Jalapeño')
    search('mint')
    for (let i = 0; i < 6; i++) add('Mint')
    const pods = towerPods()
    expect(pods.find(p => p.slot === 1)).toEqual({ slot: 1, status: 'growing', plant: 'Mint' })
    const planned = pods.filter(p => p.status === 'seeded')
    expect(planned.filter(p => p.plant === 'Jalapeño')).toHaveLength(14)
    // Some of the six Mint fit and the rest are reported below.
    expect(planned.filter(p => p.plant === 'Mint').length).toBeGreaterThan(0)
    expect(planned.length).toBeLessThan(20)
    expect(pods.filter(p => p.status === 'empty')).toHaveLength(30 - 1 - planned.length)
    expect(planned.every(p => p.planned && p.harvest?.state === 'unknown' && /^Planned: .+\.$/.test(p.harvest.reason))).toBe(true)
    expect(planned.some(p => p.harvest?.reason.includes('one zone lower'))).toBe(true)
    expect(screen.getByText(/^Didn’t fit: Mint/)).toBeTruthy()
    expect(screen.getByText(/click one for why it sits there\. Some sit one zone lower than ideal/)).toBeTruthy()
    flat()
    expect(screen.getByText(/Didn’t fit: Mint/)).toBeTruthy()
    expect(screen.getByText(/Outlined pods sit one zone lower than ideal/)).toBeTruthy()
  })

  it('hands the tower each planned plant by name, to draw grown in its slot, beside the planted ones', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }]
    render(<PlanPage />)
    search('basil')
    add('Basil')
    search('kale')
    add('Kale')
    const planned = towerPods().filter(p => p.planned)
    expect(planned.map(p => p.plant).sort()).toEqual(['Basil', 'Kale'])
    expect(towerPods().find(p => p.slot === 1)).toEqual({ slot: 1, status: 'growing', plant: 'Mint' })
  })

  it('pictures and names each plant in its slot on the 2D grid', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }]
    render(<PlanPage />)
    flat()
    search('basil')
    add('Basil')
    const grid = screen.getByTestId('plan-grid')
    const filled = [...grid.children].filter(c => c.querySelector('[data-testid="plant-thumb"]'))
    expect(filled.map(c => c.textContent?.replace(/^\d+(high|med|low)/, '')).sort()).toEqual(['Basil', 'Mint'])
    const mint = grid.querySelector('[data-slot="1"]') as HTMLElement
    expect(within(mint).getByText('Mint').className).toContain('italic')
    expect([...grid.children].filter(c => !c.querySelector('[data-testid="plant-thumb"]'))).toHaveLength(28)
  })

  it('leaves unplanned pods empty on the tower', () => {
    render(<PlanPage />)
    expect(towerPods().every(p => p.status === 'empty' && p.plant === null)).toBe(true)
    expect(screen.getByText('Planned pods show their plant grown, ringed by light zone; click one for why it sits there.')).toBeTruthy()
  })

  it('pins a pod’s callout and unpins it, and forgets it on another model', () => {
    render(<PlanPage />)
    act(() => (tower.props?.onSelect as (slot: number) => void)(4))
    expect(tower.props?.selected).toBe(4)
    act(() => (tower.props?.onClose as () => void)())
    expect(tower.props?.selected).toBeNull()
    act(() => (tower.props?.onSelect as (slot: number) => void)(20))
    fireEvent.click(screen.getByRole('tab', { name: 'Studio · 16' }))
    expect(tower.props?.selected).toBeNull()
  })

  it('remembers the view in this browser', () => {
    const { unmount } = render(<PlanPage />)
    flat()
    expect(localStorage.getItem(VIEW_KEY)).toBe('2d')
    expect(screen.getByTestId('plan-grid')).toBeTruthy()
    expect(screen.queryByTestId('tower')).toBeNull()
    unmount()
    render(<PlanPage />)
    expect(screen.getByRole('tab', { name: '2D' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('plan-grid')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '3D' }))
    expect(localStorage.getItem(VIEW_KEY)).toBe('3d')
    expect(screen.getByTestId('tower')).toBeTruthy()
  })

  it('opens on 3D and still switches when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<PlanPage />)
    expect(screen.getByTestId('tower')).toBeTruthy()
    flat()
    expect(screen.getByTestId('plan-grid')).toBeTruthy()
  })

  it('falls back to the grid, without the toggle, when there is no WebGL', async () => {
    tower.unavailable = true
    render(<PlanPage />)
    expect(await screen.findByText(/needs WebGL/)).toBeTruthy()
    expect(screen.getByTestId('plan-grid')).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Plan view' })).toBeNull()
    expect(screen.getByText(/^Italic = already planted\./)).toBeTruthy()
  })
})
