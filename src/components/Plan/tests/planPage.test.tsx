// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodState } from '@/src/components/Grow/towerScene'
import { PlanPage, shiftNotes, VIEW_KEY } from '../PlanPage'
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
    /** The layout query has not answered yet; `loading` holds back every query. */
    layoutPending: false,
    podsPending: false,
    loading: false,
    /** Pods the cameras see empty, as vision.seenEmpty answers. */
    seen: [] as number[],
    /** grow.updatePod refuses with this. */
    updateFails: null as string | null,
    /** The catalog has not answered yet. */
    catalogPending: false,
    /** Every mutation reports this error. */
    failure: null as null | string,
  },
  calls: { catalog: vi.fn(), layout: vi.fn(), save: vi.fn(), apply: vi.fn(), remove: vi.fn(), addPlant: vi.fn(), updatePlant: vi.fn(), removePlant: vi.fn(), swapPods: vi.fn(), updatePod: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/utils/trpc', async () => {
  const { findPlant, searchPlants } = await import('@/src/plants/catalog')
  const { planLayout, sowingPlan } = await import('@/src/plants/planner')
  const { MODELS, slots, zoneCounts } = await import('@/src/plants/zones')
  type Model = 'home' | 'studio'
  type PlanOverrides = Parameters<typeof planLayout>[0]['overrides']
  const mutation = (fn: (i: unknown) => void, data?: () => unknown) => ({
    useMutation: (o?: { onSuccess?: () => void }) => ({
      isPending: false,
      data: data?.(),
      error: state.failure === null ? null : { message: state.failure },
      mutate: (input: unknown, m?: { onSuccess?: () => void }) => {
        fn(input)
        o?.onSuccess?.()
        m?.onSuccess?.()
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ planner: { invalidate, plans: { invalidate } }, grow: { invalidate }, vision: { seenEmpty: { invalidate } } }),
      planner: {
        zones: { useQuery: ({ model }: { model: Model }) => ({ data: state.loading ? undefined : { ...MODELS[model], slots: slots(model), counts: zoneCounts(model) } }) },
        catalog: { useQuery: (i: { q?: string, category?: string }) => {
          calls.catalog(i)
          if (state.catalogPending) return { data: undefined }
          return { data: { plants: [...searchPlants(i as Parameters<typeof searchPlants>[0]).slice(0, 12), ...state.custom] } }
        } },
        layout: { useQuery: (i: { model: Model, plants: { plantId: string, count: number }[], overrides?: PlanOverrides, suggestMoves?: boolean }) => {
          calls.layout(i)
          if (state.layoutPending || state.loading) return { data: undefined }
          // Planted pods count as their catalog plant, as the router reads them.
          const occupied = Object.fromEntries(state.pods.filter(p => p.status !== 'empty').map(p => [p.slot, findPlant(p.plant ?? '')?.id ?? 'planted']))
          return { data: planLayout({ model: i.model, plants: i.plants, occupied, overrides: i.overrides, suggestMoves: i.suggestMoves }) }
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
      grow: {
        pods: { useQuery: () => ({ data: state.loading || state.podsPending ? undefined : state.pods }) },
        // Swaps the records, as the router does, so the page lays out around where they land.
        swapPods: mutation((i) => {
          calls.swapPods(i)
          const { a, b } = i as { a: number, b: number }
          const at = (slot: number) => state.pods.find(p => p.slot === slot) ?? { slot, plant: null, status: 'empty' }
          const [pa, pb] = [at(a), at(b)]
          state.pods = [...state.pods.filter(p => p.slot !== a && p.slot !== b), { ...pb, slot: a }, { ...pa, slot: b }]
        }),
        updatePod: { useMutation: (o?: { onSuccess?: () => void }) => ({
          isPending: false,
          error: state.failure === null ? null : { message: state.failure },
          mutate: (i: { slot: number, plant?: string | null, status?: string }) => {
            calls.updatePod(i)
            const { slot, plant, status } = i
            state.pods = state.pods.map(p => (p.slot === slot ? { ...p, ...(plant !== undefined && { plant }), ...(status && { status }) } : p))
            o?.onSuccess?.()
          },
          mutateAsync: async (i: { slot: number, plant: string | null, status: string }) => {
            calls.updatePod(i)
            if (state.updateFails) throw new Error(state.updateFails)
            state.pods = state.pods.map(p => (p.slot === i.slot ? { ...p, plant: i.plant, status: i.status } : p))
          },
        }) },
      },
      vision: {
        seenEmpty: { useQuery: () => ({ data: state.seen.map(slot => ({ slot, confidence: 0.9, ts: '2026-11-16T10:00:00Z' })) }) },
      },
    },
  }
})

beforeEach(() => {
  state.pods = []
  state.plans = []
  state.applied = null
  state.custom = []
  state.layoutPending = false
  state.loading = false
  state.podsPending = false
  state.seen = []
  state.updateFails = null
  state.catalogPending = false
  state.failure = null
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
const panel = () => within(screen.getByRole('complementary'))
// Taps a pod open, then Swap in its panel, so the next tap picks the pod to swap it with.
const startSwap = (cell: HTMLElement) => {
  fireEvent.click(cell)
  fireEvent.click(panel().getByRole('button', { name: 'Swap' }))
}

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
    expect(calls.layout).toHaveBeenLastCalledWith({ model: 'home', plants: [{ plantId: 'basil', count: 2 }], respectExisting: true, suggestMoves: true })
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

  it('keeps planted pods, leaves pods in a zone their plant tolerates unflagged, and reports what does not fit', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }, { slot: 2, plant: null, status: 'empty' }]
    render(<PlanPage />)
    flat()
    expect(screen.getByText(/0 planned · 29 empty/)).toBeTruthy()
    expect(screen.getByText('Mint')).toBeTruthy()
    search('jalapeño')
    for (let i = 0; i < 14; i++) add('Jalapeño')
    // Two sit one zone lower, in medium: ok there, so nothing is outlined.
    const ok = screen.getAllByTitle('ok here — medium light, one zone lower than its ideal high, as Gardyn advises')
    expect(ok).toHaveLength(2)
    expect(ok.every(e => !e.className.includes('outline'))).toBe(true)
    expect(screen.queryByText(/Outlined pods/)).toBeNull()
    search('arugula')
    for (let i = 0; i < 6; i++) add('Arugula')
    expect(screen.getByText('Didn’t fit: Arugula — no free slot in the low zone (low 6/6 taken)')).toBeTruthy()
    add('Arugula')
    expect(screen.getByText('Didn’t fit: Arugula ×2 — no free slot in the low zone (low 6/6 taken)')).toBeTruthy()
  })

  it('suggests optional moves for planted pods, carried out by swapping the pods once the yCubes are moved', () => {
    // A lettuce in high light and a pepper in medium: swapping them suits both.
    state.pods = [{ slot: 8, plant: 'Butterhead', status: 'growing' }, { slot: 4, plant: 'Jalapeño', status: 'growing' }]
    const { rerender } = render(<PlanPage />)
    const list = within(screen.getByRole('list', { name: 'Suggested moves' }))
    expect(list.getByRole('listitem').textContent).toBe('Swap Jalapeño in pod 4 with Butterhead in pod 8 — Butterhead gets its ideal medium light.Moved')
    fireEvent.click(list.getByRole('button', { name: 'Moved pod 4 to pod 8' }))
    expect(calls.swapPods).toHaveBeenCalledWith({ a: 4, b: 8 })
    // Swapped, nothing is left to suggest.
    rerender(<PlanPage />)
    expect(screen.queryByRole('list', { name: 'Suggested moves' })).toBeNull()
  })

  it('suggests moves that would make room', () => {
    render(<PlanPage />)
    search('jalapeño')
    for (let i = 0; i < 13; i++) add('Jalapeño')
    search('basil')
    for (let i = 0; i < 12; i++) add('Basil')
    expect(screen.getByText(/^Didn’t fit: Jalapeño — no free slot in the high or medium zones/)).toBeTruthy()
    const moves = within(screen.getByRole('list', { name: 'Ways to make room' })).getAllByRole('listitem').map(li => li.textContent)
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
    expect(calls.addPlant).toHaveBeenCalledWith({ name: 'Lovage', category: 'herb', zone: 'low', harvestMonths: [2, 3], careLevel: null, size: 'normal', tolerates: null })

    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Okra' }))
    const edit = within(screen.getByRole('dialog'))
    expect((edit.getByLabelText('Name') as HTMLInputElement).value).toBe('Okra')
    fireEvent.click(edit.getByRole('button', { name: 'Delete' }))
    expect(calls.removePlant).toHaveBeenCalledWith({ id: 'okra' })
  })

  it('swaps two planned pods from one’s panel then a tap on the other, or by dragging, without touching the pods', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }]
    render(<PlanPage />)
    flat()
    search('basil')
    add('Basil')
    search('chives')
    add('Chives')
    const grid = within(screen.getByTestId('plan-grid'))
    const slotOf = (name: string) => Number(grid.getAllByText(name)[0]?.closest('[data-slot]')?.getAttribute('data-slot'))
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    const basil = slotOf('Basil')
    const chives = slotOf('Chives')
    expect(basil).not.toBe(chives)

    fireEvent.click(cell(basil))
    expect(cell(basil).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(panel().getByRole('button', { name: 'Swap' }))
    expect(screen.getByTestId('swap-banner').textContent).toContain(`Pick the pod to swap pod ${basil} (Basil) with.`)
    fireEvent.click(cell(chives))
    expect(screen.queryByTestId('swap-banner')).toBeNull()
    expect([slotOf('Basil'), slotOf('Chives')]).toEqual([chives, basil])
    // The panel follows the plant to where it landed.
    expect(screen.getByRole('complementary', { name: `Pod ${chives}` })).toBeTruthy()
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toEqual(expect.arrayContaining([{ slot: chives, plantId: 'basil' }, { slot: basil, plantId: 'chives' }]))

    // Dragged back, the pod it's over ringed until the drop.
    const data = new Map<string, string>()
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' }
    fireEvent.dragStart(cell(chives), { dataTransfer })
    fireEvent.dragOver(cell(basil), { dataTransfer })
    expect(cell(basil).className).toContain('ring-fg-3')
    // Leaving another pod, or a drag let go of, clears the ring; leaving the ringed one does too.
    fireEvent.dragLeave(cell(chives), { dataTransfer })
    expect(cell(basil).className).toContain('ring-fg-3')
    fireEvent.dragEnd(cell(chives), { dataTransfer })
    expect(cell(basil).className).not.toContain('ring-fg-3')
    fireEvent.dragOver(cell(basil), { dataTransfer })
    fireEvent.dragLeave(cell(basil), { dataTransfer })
    expect(cell(basil).className).not.toContain('ring-fg-3')
    fireEvent.dragOver(cell(basil), { dataTransfer })
    fireEvent.drop(cell(basil), { dataTransfer })
    expect(cell(basil).className).not.toContain('ring-fg-3')
    expect([slotOf('Basil'), slotOf('Chives')]).toEqual([basil, chives])
    expect(calls.swapPods).not.toHaveBeenCalled()
  })

  it('swaps planted pods’ records, by dragging or tapping, and moves a plant planned on the other side the other way', () => {
    state.pods = [{ slot: 4, plant: 'Oregano', status: 'growing' }, { slot: 5, plant: 'Italian Parsley', status: 'growing' }]
    // The pods query answers again once a swap invalidates it.
    const { rerender } = render(<PlanPage />)
    flat()
    const grid = within(screen.getByTestId('plan-grid'))
    const slotOf = (name: string) => Number(grid.getAllByText(name)[0]?.closest('[data-slot]')?.getAttribute('data-slot'))
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    const data = new Map<string, string>()
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' }

    // Planted onto planted: the records swap.
    expect(cell(4).getAttribute('draggable')).toBe('true')
    fireEvent.dragStart(cell(4), { dataTransfer })
    fireEvent.drop(cell(5), { dataTransfer })
    expect(calls.swapPods).toHaveBeenLastCalledWith({ a: 4, b: 5 })
    rerender(<PlanPage />)
    expect([slotOf('Oregano'), slotOf('Italian Parsley')]).toEqual([5, 4])

    // Swapped from its panel onto an empty pod: the record moves there.
    startSwap(cell(5))
    fireEvent.click(cell(30))
    expect(calls.swapPods).toHaveBeenLastCalledWith({ a: 5, b: 30 })
    rerender(<PlanPage />)
    expect(slotOf('Oregano')).toBe(30)
    expect(calls.layout.mock.lastCall?.[0].overrides).toBeUndefined()

    // Onto a planned pod: the planted record moves there and the plan takes the pod it left.
    search('basil')
    add('Basil')
    const basil = slotOf('Basil')
    fireEvent.dragStart(cell(30), { dataTransfer })
    fireEvent.drop(cell(basil), { dataTransfer })
    expect(calls.swapPods).toHaveBeenLastCalledWith({ a: 30, b: basil })
    expect([slotOf('Oregano'), slotOf('Basil')]).toEqual([basil, 30])
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toEqual([{ slot: 30, plantId: 'basil' }])
  })

  it('opens a pod from the keyboard, moves a plant to a free pod, and lets go of a swap tapped back on its own pod', () => {
    render(<PlanPage />)
    flat()
    search('basil')
    add('Basil')
    const grid = within(screen.getByTestId('plan-grid'))
    const slotOf = (name: string) => Number(grid.getAllByText(name)[0]?.closest('[data-slot]')?.getAttribute('data-slot'))
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    const basil = slotOf('Basil')
    const free = basil === 30 ? 29 : 30

    startSwap(cell(basil))
    fireEvent.click(cell(basil))
    expect(screen.queryByTestId('swap-banner')).toBeNull()
    expect(slotOf('Basil')).toBe(basil)

    fireEvent.keyDown(cell(free), { key: 'Enter' })
    expect(cell(free).getAttribute('aria-pressed')).toBe('true')
    expect(panel().getByText('Nothing planned here.')).toBeTruthy()
    fireEvent.keyDown(cell(basil), { key: ' ' })
    expect(cell(basil).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(panel().getByRole('button', { name: 'Swap' }))
    fireEvent.keyDown(cell(free), { key: ' ' })
    expect(slotOf('Basil')).toBe(free)
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toEqual([{ slot: free, plantId: 'basil' }])
    // Another key does nothing.
    fireEvent.keyDown(cell(basil), { key: 'a' })
    expect(cell(basil).getAttribute('aria-pressed')).toBe('false')
  })

  it('opens a planned pod with why it sits there, changes its plant or takes it out of the plan, holding the rest still', () => {
    render(<PlanPage />)
    flat()
    search('basil')
    add('Basil')
    add('Basil')
    const grid = within(screen.getByTestId('plan-grid'))
    const cells = grid.getAllByText('Basil').map(n => Number(n.closest('[data-slot]')?.getAttribute('data-slot')))
    const [one, two] = cells as [number, number]
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    fireEvent.click(cell(one))
    const pod = within(screen.getByRole('complementary', { name: `Pod ${one}` }))
    expect(pod.getByText('Basil', { selector: 'div' })).toBeTruthy()
    expect(pod.getByText(/^Planned: .+\.$/)).toBeTruthy()
    expect((pod.getByLabelText('Plant') as HTMLSelectElement).value).toBe('basil')
    // Plants suited to the pod's light come first.
    expect(pod.getByRole('group', { name: /^Suits (high|medium|low) light$/ })).toBeTruthy()

    fireEvent.change(pod.getByLabelText('Plant'), { target: { value: 'arugula' } })
    expect(calls.layout.mock.lastCall?.[0].plants).toEqual(expect.arrayContaining([{ plantId: 'basil', count: 1 }, { plantId: 'arugula', count: 1 }]))
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toEqual(expect.arrayContaining([{ slot: one, plantId: 'arugula' }, { slot: two, plantId: 'basil' }]))
    expect(within(cell(one)).getByText('Arugula')).toBeTruthy()
    expect(within(cell(two)).getByText('Basil')).toBeTruthy()

    fireEvent.click(panel().getByRole('button', { name: 'Remove' }))
    expect(calls.layout.mock.lastCall?.[0].plants).toEqual([{ plantId: 'basil', count: 1 }])
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toEqual([{ slot: two, plantId: 'basil' }])
    expect(panel().getByText('Empty')).toBeTruthy()
    expect(panel().queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(calls.updatePod).not.toHaveBeenCalled()

    fireEvent.click(panel().getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(cell(one).getAttribute('aria-pressed')).toBe('false')
  })

  it('lets a pod’s plant use other zones for this plan, and go back to its usual ones', () => {
    state.pods = [{ slot: 1, plant: 'Arugula', status: 'growing' }]
    render(<PlanPage />)
    flat()
    search('basil')
    add('Basil')
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    const slot = Number(within(screen.getByTestId('plan-grid')).getByText('Basil').closest('[data-slot]')?.getAttribute('data-slot'))
    fireEvent.click(cell(slot))
    const group = () => within(panel().getByRole('group', { name: 'Zones for this plan' }))
    const pressed = () => group().getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])
    // Basil tolerates one zone either way.
    expect(pressed()).toEqual([['High', 'true'], ['Medium', 'true'], ['Low', 'true']])
    expect(panel().getByText('Its usual zones; change them for this plan.')).toBeTruthy()

    fireEvent.click(group().getByRole('button', { name: 'High' }))
    expect(calls.layout.mock.lastCall?.[0].overrides.allowedZones).toEqual({ basil: ['medium', 'low'] })
    expect(panel().getByText(/^Your zones for this plan\./)).toBeTruthy()
    fireEvent.click(group().getByRole('button', { name: 'Low' }))
    expect(calls.layout.mock.lastCall?.[0].overrides.allowedZones).toEqual({ basil: ['medium'] })
    // One zone at least.
    expect((group().getByRole('button', { name: 'Medium' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(group().getByRole('button', { name: 'Low' }))
    expect(calls.layout.mock.lastCall?.[0].overrides.allowedZones).toEqual({ basil: ['medium', 'low'] })
    fireEvent.click(panel().getByRole('button', { name: 'Usual zones' }))
    expect(calls.layout.mock.lastCall?.[0].overrides.allowedZones).toEqual({})
    expect(pressed()).toEqual([['High', 'true'], ['Medium', 'true'], ['Low', 'true']])

    // A planted pod's plant too; an empty pod has none to set.
    fireEvent.click(cell(1))
    expect(pressed()).toEqual([['High', 'false'], ['Medium', 'false'], ['Low', 'true']])
    fireEvent.click(cell(2))
    expect(panel().queryByRole('group', { name: 'Zones for this plan' })).toBeNull()
  })

  it('plans a plant in an empty pod from its panel, and swaps one in from another', () => {
    render(<PlanPage />)
    flat()
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    fireEvent.click(cell(30))
    expect((panel().getByLabelText('Plant') as HTMLSelectElement).value).toBe('')
    fireEvent.change(panel().getByLabelText('Plant'), { target: { value: 'borage' } })
    expect(calls.layout.mock.lastCall?.[0].plants).toEqual([{ plantId: 'borage', count: 1 }])
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toEqual([{ slot: 30, plantId: 'borage' }])
    expect(within(cell(30)).getByText('Borage')).toBeTruthy()
    expect(screen.getByText(/^1 planned/)).toBeTruthy()
    // Picking the same plant again changes nothing.
    const asked = calls.layout.mock.calls.length
    fireEvent.change(panel().getByLabelText('Plant'), { target: { value: 'borage' } })
    expect(calls.layout.mock.calls.length).toBe(asked)

    // An empty pod's swap takes the other pod's plant.
    startSwap(cell(29))
    expect(screen.getByTestId('swap-banner').textContent).toContain('Pick the pod to swap pod 29 with.')
    fireEvent.click(cell(30))
    expect(within(cell(29)).getByText('Borage')).toBeTruthy()
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toEqual([{ slot: 29, plantId: 'borage' }])
  })

  it('edits a pod in the tower the same way: its plant, Remove and Swap change its record', () => {
    state.pods = [{ slot: 4, plant: 'Arugula', status: 'growing' }]
    const { rerender } = render(<PlanPage />)
    flat()
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    fireEvent.click(cell(4))
    expect(panel().getByText('In the tower now.')).toBeTruthy()
    expect((panel().getByLabelText('Plant') as HTMLSelectElement).value).toBe('arugula')

    fireEvent.change(panel().getByLabelText('Plant'), { target: { value: 'basil' } })
    expect(calls.updatePod).toHaveBeenLastCalledWith({ slot: 4, plant: 'Basil' })
    expect(invalidate).toHaveBeenCalled()
    rerender(<PlanPage />)
    expect(within(cell(4)).getByText('Basil')).toBeTruthy()
    // The plan itself is untouched.
    expect(calls.layout.mock.lastCall?.[0].plants).toEqual([])

    // Swap, then Cancel, leaves it where it is.
    fireEvent.click(panel().getByRole('button', { name: 'Swap' }))
    fireEvent.click(within(screen.getByTestId('swap-banner')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('swap-banner')).toBeNull()
    fireEvent.click(cell(9))
    expect(calls.swapPods).not.toHaveBeenCalled()

    // A planned plant swapped onto it moves its record the other way.
    fireEvent.click(cell(30))
    fireEvent.change(panel().getByLabelText('Plant'), { target: { value: 'borage' } })
    startSwap(cell(30))
    fireEvent.click(cell(4))
    expect(calls.swapPods).toHaveBeenLastCalledWith({ a: 30, b: 4 })
    rerender(<PlanPage />)

    fireEvent.click(cell(30))
    fireEvent.click(panel().getByRole('button', { name: 'Remove' }))
    expect(calls.updatePod).toHaveBeenLastCalledWith({ slot: 30, plant: null, plantedAt: null, status: 'empty', notes: '' })
  })

  it('says why a pod edit failed, and opens a pod before the catalog answers', () => {
    state.failure = 'the unit is offline'
    state.catalogPending = true
    render(<PlanPage />)
    flat()
    expect(screen.getAllByText('the unit is offline')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('plan-grid').querySelector('[data-slot="3"]') as HTMLElement)
    expect(panel().queryAllByRole('option', { name: /./ }).filter(o => !(o as HTMLOptionElement).disabled)).toHaveLength(0)
  })

  it('names a planted plant the catalog doesn’t know, and closes the panel on another model', () => {
    state.pods = [{ slot: 2, plant: 'Mystery herb', status: 'growing' }]
    render(<PlanPage />)
    flat()
    fireEvent.click(screen.getByTestId('plan-grid').querySelector('[data-slot="2"]') as HTMLElement)
    const plant = panel().getByLabelText('Plant') as HTMLSelectElement
    expect(plant.value).toBe('')
    expect(plant.selectedOptions[0]?.textContent).toBe('Mystery herb')
    fireEvent.click(screen.getByRole('tab', { name: 'Studio · 16' }))
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('drops pins past a lower count, and forgets swaps on another model', () => {
    render(<PlanPage />)
    flat()
    search('basil')
    add('Basil')
    add('Basil')
    const grid = within(screen.getByTestId('plan-grid'))
    const cells = grid.getAllByText('Basil').map(n => Number(n.closest('[data-slot]')?.getAttribute('data-slot')))
    const cell = (slot: number) => screen.getByTestId('plan-grid').querySelector(`[data-slot="${slot}"]`) as HTMLElement
    startSwap(cell(cells[0] as number))
    fireEvent.click(cell(cells[1] as number))
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Basil' }))
    expect(calls.layout.mock.lastCall?.[0].overrides.pins).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: 'Studio · 16' }))
    expect(calls.layout.mock.lastCall?.[0].overrides).toBeUndefined()
  })

  it('counts the pods a plan leaves empty, not the pods unplanted today', () => {
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }]
    render(<PlanPage />)
    search('basil')
    for (let i = 0; i < 21; i++) add('Basil')
    // Medium 12, the 5 low pods mint leaves, then 4 high; 8 high pods stay empty, not the 29 unplanted today.
    expect(towerPods().filter(p => p.planned)).toHaveLength(21)
    expect(screen.getByText(/^21 planned · 8 empty ·/)).toBeTruthy()
  })

  it('counts the pods unplanted today until the layout answers, with nothing to say about zones', () => {
    state.layoutPending = true
    state.pods = [{ slot: 1, plant: 'Mint', status: 'growing' }, { slot: 2, plant: null, status: 'empty' }]
    render(<PlanPage />)
    expect(screen.getByText(/^0 planned · 29 empty ·/)).toBeTruthy()
    expect(screen.getByText('Planned pods show their plant grown, ringed by light zone; click one for why it sits there, or drag one onto another pod to swap them.')).toBeTruthy()
    flat()
    expect(screen.getByText('Tap a pod to change its plant or swap it, or drag a plant onto another pod to swap them. Italic = in the tower now.')).toBeTruthy()
    cleanup()

    // Nothing has answered: no count to give yet.
    state.loading = true
    render(<PlanPage />)
    expect(screen.getByText(/^0 planned · 0 empty ·/)).toBeTruthy()
    cleanup()

    // The tower's zones but not its pods: every pod counts as empty.
    state.loading = false
    state.podsPending = true
    render(<PlanPage />)
    expect(screen.getByText(/^0 planned · 30 empty ·/)).toBeTruthy()
  })

  it('flags only pods outside the zones their plant does well in, lower and higher apart', () => {
    const at = (fit: 'ideal' | 'ok' | 'outside' | undefined, shift: 'lower' | 'higher' | null) => ({ slot: 1, plantId: 'jalapeno', plantName: 'Jalapeño', reason: '', fallback: 1, shift, fit })
    expect(shiftNotes([at('ok', 'lower'), at('ok', 'higher'), at('ideal', null), at('outside', null)], '2d')).toBe('')
    // A layout saved before fit existed flags nothing.
    expect(shiftNotes([at(undefined, 'lower')], '2d')).toBe('')
    expect(shiftNotes([at('outside', 'lower')], '2d')).toBe(' Outlined pods sit lower than the zones their plant does well in, so expect slower growth.')
    expect(shiftNotes([at('outside', 'lower'), at('outside', 'higher')], '3d')).toBe(' Some sit lower than the zones their plant does well in, so expect slower growth. Some sit higher than the zones their plant does well in, in more light than it likes.')
  })

  it('tells pods you placed above the zones their plant does well in apart from ones below them', () => {
    // A saved plan with a lettuce pinned in high light and a pepper in low.
    const overrides = { pins: [{ slot: 8, plantId: 'butterhead' }, { slot: 1, plantId: 'jalapeno' }] }
    state.plans = [{ id: 'mcp-2', name: 'Mixed', model: 'home', mode: 'staggered', appliedAt: null, start: null, layout: { model: 'home', assignments: [], unplaced: [], free: [], overrides }, request: [{ plantId: 'butterhead', count: 1 }, { plantId: 'jalapeno', count: 1 }] }]
    render(<PlanPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in planner' }))
    expect(screen.getByText(/drag one onto another pod to swap them\. Some sit lower than the zones their plant does well in, so expect slower growth\. Some sit higher than the zones their plant does well in, in more light than it likes\.$/)).toBeTruthy()
    expect(towerPods().filter(p => p.harvest?.reason === 'Planned: you placed it here — high light, outside the zones it does well in (ideal medium).')).toHaveLength(1)
    flat()
    const higher = screen.getByTitle('you placed it here — high light, outside the zones it does well in (ideal medium)')
    expect(higher.className).toContain('outline-dashed')
    expect(higher.className).not.toContain('outline-[var(--status-warn)]')
    expect(screen.getByTitle('you placed it here — low light, outside the zones it does well in (ideal high)').className).toContain('outline-[var(--status-warn)]')
  })

  it('opens a saved plan (e.g. one an agent saved) with its layout, overrides and schedule, and updates it in place', () => {
    const overrides = { pins: [{ slot: 4, plantId: 'basil' }] }
    state.plans = [{ id: 'mcp-1', name: 'Gardyn order', model: 'studio', mode: 'staggered', appliedAt: null, start: '2026-10-01', layout: { model: 'studio', assignments: [{ slot: 4 }, { slot: 7 }], unplaced: [], free: [], overrides }, request: [{ plantId: 'basil', count: 2 }] }]
    render(<PlanPage />)
    flat()
    fireEvent.click(screen.getByRole('button', { name: 'Open in planner' }))
    expect(screen.getByText('editing')).toBeTruthy()
    expect(calls.layout).toHaveBeenLastCalledWith({ model: 'studio', plants: [{ plantId: 'basil', count: 2 }], respectExisting: true, suggestMoves: true, overrides })
    expect(screen.getByText('High 5')).toBeTruthy()
    expect((screen.getByLabelText('Plan name') as HTMLInputElement).value).toBe('Gardyn order')
    expect(screen.getAllByText(/sow 2026-10-01 → harvest/)).toHaveLength(1)
    expect(screen.getByTitle('you placed it here')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Update plan' }))
    expect(calls.save).toHaveBeenCalledWith({ id: 'mcp-1', name: 'Gardyn order', model: 'studio', mode: 'staggered', plants: [{ plantId: 'basil', count: 2 }], start: '2026-10-01', overrides })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    add('Basil')
    expect(calls.layout).toHaveBeenLastCalledWith({ model: 'studio', plants: [{ plantId: 'basil', count: 1 }], respectExisting: true, suggestMoves: true })
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
    search('arugula')
    for (let i = 0; i < 6; i++) add('Arugula')
    const pods = towerPods()
    expect(pods.find(p => p.slot === 1)).toEqual({ slot: 1, status: 'growing', plant: 'Mint' })
    const planned = pods.filter(p => p.status === 'seeded')
    expect(planned.filter(p => p.plant === 'Jalapeño')).toHaveLength(14)
    // Five of the six arugula fit and the rest are reported below.
    expect(planned.filter(p => p.plant === 'Arugula')).toHaveLength(5)
    expect(pods.filter(p => p.status === 'empty')).toHaveLength(30 - 1 - planned.length)
    expect(planned.every(p => p.planned && p.harvest?.state === 'unknown' && /^Planned: .+\.$/.test(p.harvest.reason))).toBe(true)
    expect(planned.some(p => p.harvest?.reason.includes('ok here — medium light, one zone lower'))).toBe(true)
    expect(screen.getByText(/^Didn’t fit: Arugula/)).toBeTruthy()
    expect(screen.queryByText(/Some sit/)).toBeNull()
    flat()
    expect(screen.getByText(/Didn’t fit: Arugula/)).toBeTruthy()
    expect(screen.queryByText(/Outlined pods/)).toBeNull()
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
    expect(screen.getByText('Planned pods show their plant grown, ringed by light zone; click one for why it sits there, or drag one onto another pod to swap them.')).toBeTruthy()
  })

  it('swaps any pod onto any other on the tower, as the grid does', () => {
    state.pods = [{ slot: 4, plant: 'Oregano', status: 'growing' }]
    const { rerender } = render(<PlanPage />)
    const onSwap = (from: number, to: number) => act(() => (tower.props?.onSwap as (from: number, to: number) => void)(from, to))
    const at = (slot: number) => towerPods().find(p => p.slot === slot)
    search('basil')
    add('Basil')
    search('chives')
    add('Chives')
    const slotOf = (name: string) => towerPods().find(p => p.planned && p.plant === name)?.slot as number
    const [basil, chives] = [slotOf('Basil'), slotOf('Chives')]
    const free = [30, 29, 28].find(s => s !== basil && s !== chives) as number

    // Planned onto planned, then an empty pod onto a planned one: the plan's pins move.
    onSwap(basil, chives)
    expect([slotOf('Basil'), slotOf('Chives')]).toEqual([chives, basil])
    onSwap(free, chives)
    expect(slotOf('Basil')).toBe(free)
    expect(calls.swapPods).not.toHaveBeenCalled()

    // A pod with a plant in it swaps records, and a plan on the other side follows.
    onSwap(4, free)
    expect(calls.swapPods).toHaveBeenLastCalledWith({ a: 4, b: free })
    rerender(<PlanPage />)
    expect(at(free)).toMatchObject({ plant: 'Oregano', status: 'growing' })
    expect(slotOf('Basil')).toBe(4)

    // Onto itself, or empty onto empty: nothing to do.
    const layouts = calls.layout.mock.calls.length
    onSwap(free, free)
    onSwap(1, 2)
    expect(calls.swapPods).toHaveBeenCalledTimes(1)
    expect(calls.layout.mock.calls.length).toBe(layouts)
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
    expect(screen.getByText(/swap them\. Italic = in the tower now\./)).toBeTruthy()
  })

  it('flags planted pods the cameras see empty on the tower and the grid, and marks them empty after one confirm', async () => {
    state.pods = [{ slot: 4, plant: 'Kale', status: 'growing' }, { slot: 5, plant: 'Basil', status: 'harvest' }, { slot: 6, plant: 'Mint', status: 'growing' }]
    // Pod 7 is already empty and pod 31 is past the Home tower, so neither is named.
    state.seen = [4, 5, 7, 31]
    const { rerender } = render(<PlanPage />)
    const notice = screen.getByRole('status', { name: 'Pods seen empty' })
    expect(notice.textContent).toContain('Cameras see pods 4, 5 empty.')
    expect(towerPods().filter(p => p.seenEmpty).map(p => p.slot)).toEqual([4, 5])
    flat()
    const grid = screen.getByTestId('plan-grid')
    expect(within(grid).getAllByTestId('seen-empty')).toHaveLength(2)
    // The plant fades, rather than taking an outline: those mark zones.
    expect(within(grid).getByRole('button', { name: 'Pod 4, Kale, cameras see it empty' }).querySelector('.opacity-50')?.textContent).toBe('Kale')
    expect(within(grid).getByRole('button', { name: 'Pod 6, Mint' }).querySelector('.opacity-50')).toBeNull()

    // Nothing changes until it's confirmed.
    fireEvent.click(within(notice).getByRole('button', { name: 'Mark empty' }))
    expect(notice.textContent).toContain('Mark pods 4, 5 empty?')
    fireEvent.click(within(notice).getByRole('button', { name: 'Cancel' }))
    expect(calls.updatePod).not.toHaveBeenCalled()
    fireEvent.click(within(notice).getByRole('button', { name: 'Mark empty' }))
    await act(async () => fireEvent.click(within(notice).getByRole('button', { name: 'Yes, mark empty' })))
    expect(calls.updatePod.mock.calls.map(c => c[0])).toEqual([
      { slot: 4, plant: null, plantedAt: null, status: 'empty', notes: '' },
      { slot: 5, plant: null, plantedAt: null, status: 'empty', notes: '' },
    ])
    expect(invalidate).toHaveBeenCalledTimes(3)
    // The pods are free for the plan now, once the queries answer again.
    rerender(<PlanPage />)
    expect(screen.queryByRole('status', { name: 'Pods seen empty' })).toBeNull()
    expect(within(grid).queryAllByTestId('seen-empty')).toHaveLength(0)
  })

  it('names a single pod seen empty, says why marking it failed, and says nothing on a replant', async () => {
    state.pods = [{ slot: 4, plant: 'Kale', status: 'growing' }]
    state.seen = [4]
    state.updateFails = 'pod 4 is busy'
    render(<PlanPage />)
    const notice = screen.getByRole('status', { name: 'Pods seen empty' })
    expect(notice.textContent).toContain('Cameras see pod 4 empty.')
    fireEvent.click(within(notice).getByRole('button', { name: 'Mark empty' }))
    await act(async () => fireEvent.click(within(notice).getByRole('button', { name: 'Yes, mark empty' })))
    expect(notice.textContent).toContain('pod 4 is busy')
    expect(notice.textContent).toContain('Mark pod 4 empty?')
    cleanup()
    state.plans = [{ id: 'p1', name: 'Fresh', model: 'home', mode: 'batch', appliedAt: null, start: null, layout: { model: 'home', assignments: [], unplaced: [], free: [], overrides: { replant: true } }, request: [{ plantId: 'oregano', count: 1 }] }]
    render(<PlanPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in planner' }))
    expect(screen.queryByRole('status', { name: 'Pods seen empty' })).toBeNull()
  })
})
