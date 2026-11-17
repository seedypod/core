// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { podRegions } from '@/src/vision/regions'
import { HISTORY, LabelPods, NOT_VISIBLE, PAGE, rounds } from '../LabelPods'

// Pod codes have their own tests (podCodes.test.tsx).
vi.mock('../PodCodes', () => ({ PodCodes: () => null }))
vi.mock('../PodOrder', () => ({ PodOrder: () => null }))

const { data, calls, invalidate, mutation, infinite } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { frames: vi.fn(), get: vi.fn(), labels: vi.fn(), setLabel: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), restore: vi.fn(), labelList: vi.fn(), fetchNextPage: vi.fn() },
  invalidate: vi.fn(),
  mutation: { fail: false, error: null as null | { message: string }, acceptFail: false, acceptError: null as null | { message: string }, dismissFail: false, dismissError: null as null | { message: string }, restoreError: null as null | { message: string } },
  infinite: { hasNextPage: false, isLoading: false },
}))

vi.mock('@/src/utils/trpc', () => ({
  apiBase: () => 'http://unit',
  trpc: {
    useUtils: () => ({ vision: { invalidate } }),
    camera: { list: { useQuery: (input: { camera: string }, opts?: { enabled?: boolean }) => {
      if (opts?.enabled !== false) calls.frames(input)
      return { data: opts?.enabled === false ? undefined : data.get(`frames:${input.camera}`) }
    } }, get: { useQuery: (input: { id: string }, opts: { enabled: boolean }) => {
      if (!opts.enabled) return { data: undefined, error: null }
      calls.get(input)
      const got = data.get(`capture:${input.id}`)
      return { data: got, error: got ? null : { message: `no capture ${input.id}` } }
    } } },
    vision: {
      labels: { useQuery: (input: { captureId: string }, opts?: { enabled?: boolean }) => {
        calls.labels(input, opts)
        return { data: opts?.enabled === false ? undefined : data.get(`labels:${input.captureId}`) }
      } },
      suggestions: { useQuery: (input: { captureId: string }, opts?: { enabled?: boolean }) => ({ data: opts?.enabled === false ? undefined : data.get(`hints:${input.captureId}`) }) },
      dismissals: { useQuery: (input: { captureId: string }, opts?: { enabled?: boolean }) => ({ data: opts?.enabled === false ? undefined : data.get(`dismissed:${input.captureId}`) }) },
      dismissSuggestion: { useMutation: (o: { onSuccess?: () => void, onError?: (e: Error, v: unknown) => void }) => ({
        error: mutation.dismissError,
        mutate: (v: unknown) => {
          calls.dismiss(v)
          if (mutation.dismissFail) o.onError?.(new Error('nope'), v)
          else o.onSuccess?.()
        },
      }) },
      restoreSuggestion: { useMutation: (o: { onSuccess?: () => void, onError?: (e: Error, v: unknown) => void }) => ({
        error: mutation.restoreError,
        mutate: (v: unknown) => {
          calls.restore(v)
          if (mutation.dismissFail) o.onError?.(new Error('nope'), v)
          else o.onSuccess?.()
        },
      }) },
      acceptSuggestions: { useMutation: (o: { onSuccess?: () => void, onError?: (e: Error, v: unknown) => void }) => ({
        error: mutation.acceptError,
        isPending: false,
        mutate: (v: unknown) => {
          calls.accept(v)
          if (mutation.acceptFail) o.onError?.(new Error('nope'), v)
          else o.onSuccess?.()
        },
      }) },
      labelStats: { useQuery: () => ({ data: data.get('stats') }) },
      labelList: { useInfiniteQuery: (input: { label?: string, limit: number }, opts: { getNextPageParam: (p: { next: string | null }) => string | undefined }) => {
        calls.labelList(input, opts.getNextPageParam({ next: 'cursor-1' }), opts.getNextPageParam({ next: null }))
        const labels = (data.get('list') as Array<{ label: string }> | undefined)?.filter(l => !input.label || l.label === input.label)
        return { data: labels && { pages: [{ labels, next: null }] }, ...infinite, isFetchingNextPage: false, fetchNextPage: calls.fetchNextPage }
      } },
      setLabel: { useMutation: (o: { onSuccess?: () => void, onError?: (e: Error, v: unknown) => void }) => ({
        error: mutation.error,
        isPending: false,
        mutate: (v: unknown) => {
          calls.setLabel(v)
          if (mutation.fail) o.onError?.(new Error('nope'), v)
          else o.onSuccess?.()
        },
      }) },
    },
  },
}))

const frame = (camera: string, i: number) => ({ id: `${camera}-${i}`, camera, ts: `2026-11-0${9 - i}T10:00:00Z`, path: `${camera}-${i}.jpg`, bytes: 1, url: `/api/captures/${camera}-${i}.jpg` })
const label = (captureId: string, slot: number, l: string) => ({ captureId, ts: '', camera: 'upper', slot, label: l, labelledAt: '', plant: null, plantedAt: null })
const entry = (captureId: string, camera: 'upper' | 'lower', slot: number, l: string, more: Record<string, unknown> = {}) => ({
  captureId, ts: '2026-11-08T10:00:00Z', camera, slot, label: l, labelledAt: '', plant: null, plantedAt: null, daysSinceSowing: null, url: `/api/captures/${captureId}.jpg`, ...more,
})
const pod = (slot: number) => screen.getByRole('button', { name: new RegExp(`^Pod ${slot}:`) })
const chip = (name: string) => within(screen.getByRole('group', { name: 'Label to apply' })).getByRole('button', { name: new RegExp(`^${name}(, \\d+ labelled)?$`) })
const boxes = (c: 'upper' | 'lower') => podRegions(c)
const stats = { counts: { empty: 4, seeded: 3, sprouted: 1, growing: 0, ready: 2, unhealthy: 1 }, pods: 11, captures: [] }

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  invalidate.mockReset()
  mutation.fail = false
  mutation.error = null
  mutation.acceptFail = false
  mutation.acceptError = null
  mutation.dismissFail = false
  mutation.dismissError = null
  mutation.restoreError = null
  infinite.hasNextPage = false
  infinite.isLoading = false
})
afterEach(cleanup)

describe('LabelPods', () => {
  it('shows each label\'s count and the newest upper still with its labels', () => {
    data.set('frames:upper', [frame('upper', 0), frame('upper', 1)])
    data.set('labels:upper-0', [label('upper-0', 2, 'sprouted')])
    data.set('stats', stats)
    render(<LabelPods boxes={boxes} />)
    expect(calls.frames).toHaveBeenCalledTimes(1)
    expect(calls.frames).toHaveBeenLastCalledWith({ camera: 'upper', limit: HISTORY })
    expect(chip('Empty').getAttribute('aria-label')).toBe('Empty, 4 labelled')
    expect(chip('Seeded').getAttribute('aria-label')).toBe('Seeded, 3 labelled')
    expect(chip('Unhealthy').getAttribute('aria-label')).toBe('Unhealthy, 1 labelled')
    expect(screen.queryByLabelText('Label counts')).toBeNull()
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/upper-0.jpg')
    expect(screen.getByTestId('label-pods-upper').querySelectorAll('button')).toHaveLength(15)
    expect(pod(2).getAttribute('aria-label')).toBe('Pod 2: sprouted')
    expect(pod(2).textContent).toBe('2 · sprouted')
    expect(pod(1).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(/ · upper · 1 of 15 labelled$/)).toBeTruthy()
  })

  it('offers seeded between empty and sprouted, says what each label means, and how to remove one', () => {
    data.set('frames:upper', [frame('upper', 0)])
    render(<LabelPods boxes={boxes} />)
    const chips = within(screen.getByRole('group', { name: 'Label to apply' })).getAllByRole('button').map(b => b.textContent)
    expect(chips).toEqual(['Empty0', 'Seeded0', 'Sprouted0', 'Growing0', 'Ready0', 'Unhealthy0', 'Clear'])
    expect(chip('Empty').getAttribute('title')).toBe('Capped, no yCube')
    expect(chip('Sprouted').getAttribute('title')).toBe('Only seed leaves: the first pair of small, rounded leaves')
    expect(chip('Growing').getAttribute('title')).toBe('True leaves showing (the plant\'s own leaf shape), not ready yet')
    expect(chip('Seeded').getAttribute('title')).toBe('A yCube in, nothing visible yet')
    // Under the photo, what a tap does with the chip picked.
    expect(screen.getByText('Tap a dashed pod to accept it · dashed = suggestion')).toBeTruthy()
    expect(chip('Clear').getAttribute('title')).toBe('Taps take a pod\'s label off, or dismiss its suggestion')
    fireEvent.click(chip('Clear'))
    expect(screen.getByText('Tap a pod to take its label off, or dismiss its suggestion on this photo · dashed = suggestion')).toBeTruthy()
    // Without a way to the pod boxes, no card for them.
    expect(screen.queryByRole('region', { name: 'Pod bounds' })).toBeNull()
    expect(screen.getByText(/Empty is capped, Seeded has a yCube/)).toBeTruthy()
    fireEvent.click(chip('Seeded'))
    expect(screen.getByText('Tap a pod to set Seeded · dashed = suggestion')).toBeTruthy()
    fireEvent.click(pod(7))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 7, label: 'seeded' })
    expect(pod(7).getAttribute('aria-label')).toBe('Pod 7: seeded')
  })

  it('tags a pod with one tap, retags it with another label, and clears it with a second tap', () => {
    data.set('frames:upper', [frame('upper', 0)])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(chip('Growing'))
    fireEvent.click(pod(4))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 4, label: 'growing' })
    expect(pod(4).getAttribute('aria-label')).toBe('Pod 4: growing')
    expect(invalidate).toHaveBeenCalled()
    expect(chip('Growing').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip('Ready'))
    expect(chip('Ready').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(pod(4))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 4, label: 'ready' })
    fireEvent.click(pod(4))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 4, label: null })
    expect(pod(4).getAttribute('aria-label')).toBe('Pod 4: not labelled')
  })

  it('takes labels off with Clear, and leaves untagged pods alone', () => {
    data.set('frames:upper', [frame('upper', 0)])
    data.set('labels:upper-0', [label('upper-0', 5, 'ready'), label('upper-0', 6, 'empty')])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(chip('Clear'))
    expect(chip('Clear').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(pod(5))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 5, label: null })
    expect(pod(5).getAttribute('aria-label')).toBe('Pod 5: not labelled')
    fireEvent.click(pod(6))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 6, label: null })
    calls.setLabel.mockReset()
    fireEvent.click(pod(1))
    fireEvent.click(pod(5))
    expect(calls.setLabel).not.toHaveBeenCalled()
  })

  it('puts a tag back when the unit refuses it, and says why', () => {
    data.set('frames:upper', [frame('upper', 0)])
    data.set('labels:upper-0', [label('upper-0', 5, 'empty')])
    mutation.fail = true
    mutation.error = { message: 'no capture upper-0' }
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(chip('Unhealthy'))
    fireEvent.click(pod(5))
    expect(pod(5).getAttribute('aria-label')).toBe('Pod 5: empty')
    expect(screen.getByText('no capture upper-0')).toBeTruthy()
  })

  it('steps to older and newer photos, and switches camera', () => {
    data.set('frames:upper', [frame('upper', 0), frame('upper', 1)])
    data.set('frames:lower', [frame('lower', 0)])
    render(<LabelPods boxes={boxes} />)
    const newer = screen.getByRole('button', { name: 'Newer photo' }) as HTMLButtonElement
    const older = screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement
    expect(newer.disabled).toBe(true)
    fireEvent.click(older)
    expect(calls.labels).toHaveBeenCalledWith({ captureId: 'upper-1' }, { enabled: true })
    expect(older.disabled).toBe(true)
    fireEvent.click(chip('Growing'))
    fireEvent.click(pod(1))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-1', slot: 1, label: 'growing' })
    calls.labels.mockReset()
    fireEvent.click(newer)
    expect(calls.labels).toHaveBeenCalledWith({ captureId: 'upper-0' }, { enabled: true })
    // A tag on one photo doesn't show on the next.
    expect(pod(1).getAttribute('aria-label')).toBe('Pod 1: not labelled')

    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))
    expect(calls.frames).toHaveBeenLastCalledWith({ camera: 'lower', limit: HISTORY })
    expect(screen.getByRole('button', { name: /^Pod 16:/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Pod 1:/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Pod 30:/ }))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 30, label: 'growing' })
  })

  it('says when a camera has no photos, and takes a demo still as it is', () => {
    data.set('frames:lower', [{ ...frame('lower', 0), path: 'data:image/svg+xml;utf8,<svg/>' }])
    render(<LabelPods boxes={boxes} />)
    expect(screen.getByText('No photos from this camera yet.')).toBeTruthy()
    expect(calls.labels).toHaveBeenLastCalledWith({ captureId: '' }, { enabled: false })
    expect((screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.src).toMatch(/^data:image\/svg/)
    Object.defineProperty(img, 'naturalWidth', { value: 1280 })
    Object.defineProperty(img, 'naturalHeight', { value: 720 })
    fireEvent.load(img)
    expect((img.parentElement as HTMLElement).style.aspectRatio).toMatch(/^1\.77/)
  })

  it('shows both cameras from one round together, labelled apart, and steps them by time', () => {
    data.set('frames:upper', [frame('upper', 0), frame('upper', 1), frame('upper', 2)])
    data.set('frames:lower', [{ ...frame('lower', 0), ts: '2026-11-09T10:00:20Z' }, { ...frame('lower', 1), ts: '2026-11-08T10:00:20Z' }])
    data.set('labels:lower-0', [{ ...label('lower-0', 20, 'ready'), camera: 'lower' }])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Both' }))
    expect(calls.frames).toHaveBeenCalledWith({ camera: 'upper', limit: HISTORY })
    expect(calls.frames).toHaveBeenCalledWith({ camera: 'lower', limit: HISTORY })
    expect(screen.getByTestId('label-pods-upper').querySelectorAll('button')).toHaveLength(15)
    expect(screen.getByTestId('label-pods-lower').querySelectorAll('button')).toHaveLength(15)
    expect(screen.getAllByRole('img').map(i => (i as HTMLImageElement).src)).toEqual(['http://unit/api/captures/upper-0.jpg', 'http://unit/api/captures/lower-0.jpg'])
    expect(screen.getByText(/ · both · 1 of 30 labelled$/)).toBeTruthy()
    // Side by side, the word doesn't fit a box: the fill says it.
    expect(pod(20).textContent).toBe('20')
    expect(pod(20).getAttribute('aria-label')).toBe('Pod 20: ready')

    fireEvent.click(chip('Growing'))
    fireEvent.click(pod(3))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 3, label: 'growing' })
    fireEvent.click(pod(16))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 16, label: 'growing' })
    expect(screen.getByText(/ · both · 3 of 30 labelled$/)).toBeTruthy()

    const older = screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement
    fireEvent.click(older)
    expect(screen.getAllByRole('img').map(i => (i as HTMLImageElement).alt)).toEqual(['upper camera at 2026-11-08T10:00:00Z', 'lower camera at 2026-11-08T10:00:20Z'])
    expect(pod(3).getAttribute('aria-label')).toBe('Pod 3: not labelled')
    fireEvent.click(older)
    // The lower camera took nothing that round: an empty slot, not an older still.
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByText('No lower still this round.')).toBeTruthy()
    expect(screen.queryByTestId('label-pods-lower')).toBeNull()
    expect(screen.getByText(/ · both · 0 of 15 labelled$/)).toBeTruthy()
    expect(older.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Newer photo' }))
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('groups stills into rounds of one per camera, newest first, without reaching past a round', () => {
    const f = (camera: 'upper' | 'lower', ts: string) => ({ ...frame(camera, 0), id: `${camera}@${ts.slice(11, 19)}`, camera, ts })
    expect(rounds([])).toEqual([])
    const got = rounds([
      f('upper', '2026-11-09T10:00:00Z'), f('lower', '2026-11-09T10:00:20Z'),
      f('upper', '2026-11-09T09:00:00Z'), f('lower', '2026-11-09T09:00:20Z'),
      // A still taken by hand, far from a round, and two of one camera close together.
      f('upper', '2026-11-09T09:30:00Z'), f('upper', '2026-11-09T08:00:00Z'), f('upper', '2026-11-09T07:59:00Z'),
      // A lower still more than five minutes from any upper one.
      f('lower', '2026-11-09T07:50:00Z'),
    ])
    expect(got.map(r => [r.ts, r.upper?.id ?? null, r.lower?.id ?? null])).toEqual([
      ['2026-11-09T10:00:20Z', 'upper@10:00:00', 'lower@10:00:20'],
      ['2026-11-09T09:30:00Z', 'upper@09:30:00', null],
      ['2026-11-09T09:00:20Z', 'upper@09:00:00', 'lower@09:00:20'],
      ['2026-11-09T08:00:00Z', 'upper@08:00:00', null],
      ['2026-11-09T07:59:00Z', 'upper@07:59:00', null],
      ['2026-11-09T07:50:00Z', null, 'lower@07:50:00'],
    ])
  })

  it('lists every label as its pod\'s crop, filters them by label, and changes or removes one', () => {
    data.set('stats', stats)
    data.set('list', [
      entry('upper-1', 'upper', 3, 'seeded', { plant: 'Basil', plantedAt: '2026-11-01', daysSinceSowing: 7 }),
      entry('lower-1', 'lower', 20, 'ready'),
      entry('upper-gone', 'upper', 2, 'seeded', { url: null }),
    ])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    expect(screen.queryByRole('tab', { name: 'Both' })).toBeNull()
    expect(calls.labelList).toHaveBeenLastCalledWith({ label: undefined, limit: PAGE }, 'cursor-1', undefined)
    const filters = within(screen.getByRole('group', { name: 'Show labels' })).getAllByRole('button').map(b => b.textContent)
    expect(filters).toEqual(['All 11', 'Empty 4', 'Seeded 3', 'Sprouted 1', 'Growing 0', 'Ready 2', 'Unhealthy 1'])
    const tiles = screen.getAllByTestId('label-tile')
    expect(tiles).toHaveLength(3)
    const first = tiles[0] as HTMLElement
    expect(first.textContent).toContain('Seeded')
    expect(first.textContent).toContain('Pod 3')
    expect(first.textContent).toContain('Basil · day 7')
    expect(tiles[1]?.textContent).toContain('No plant')
    // The crop is the still scaled so pod 3's box fills the tile.
    const box = boxes('upper')[3] as { x: number, y: number, w: number, h: number }
    const crop = within(first).getByRole('img') as HTMLImageElement
    expect(crop.src).toBe('http://unit/api/captures/upper-1.jpg')
    expect(parseFloat(crop.style.width)).toBeCloseTo(100 / box.w)
    expect(parseFloat(crop.style.left)).toBeCloseTo(-100 * box.x / box.w)
    expect(parseFloat(crop.style.top)).toBeCloseTo(-100 * box.y / box.h)
    expect(within(tiles[2] as HTMLElement).getByText('Photo pruned')).toBeTruthy()

    fireEvent.click(within(screen.getByRole('group', { name: 'Show labels' })).getByRole('button', { name: /^Seeded/ }))
    expect(calls.labelList).toHaveBeenLastCalledWith({ label: 'seeded', limit: PAGE }, 'cursor-1', undefined)
    expect(screen.getAllByTestId('label-tile')).toHaveLength(2)

    const tile = screen.getAllByTestId('label-tile')[0] as HTMLElement
    fireEvent.click(within(tile).getByRole('button', { name: 'Change' }))
    const picks = within(tile).getByRole('group', { name: 'New label for pod 3' })
    expect(within(picks).queryByRole('button', { name: 'Clear' })).toBeNull()
    fireEvent.click(within(picks).getByRole('button', { name: 'Seeded' }))
    expect(calls.setLabel).not.toHaveBeenCalled()
    fireEvent.click(within(picks).getByRole('button', { name: 'Sprouted' }))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-1', slot: 3, label: 'sprouted' })
    expect(invalidate).toHaveBeenCalled()
    expect(within(tile).queryByRole('group')).toBeNull()
    fireEvent.click(within(screen.getAllByTestId('label-tile')[1] as HTMLElement).getByRole('button', { name: 'Remove' }))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-gone', slot: 2, label: null })

    fireEvent.click(within(screen.getByRole('group', { name: 'Show labels' })).getByRole('button', { name: /^Unhealthy/ }))
    expect(screen.getByText('No pods labelled Unhealthy yet.')).toBeTruthy()
  })

  it('loads more labels a page at a time, and says when there are none', () => {
    infinite.hasNextPage = true
    data.set('list', [entry('upper-1', 'upper', 3, 'seeded')])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    expect(screen.getByText('All 0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(calls.fetchNextPage).toHaveBeenCalled()
    cleanup()
    infinite.hasNextPage = false
    data.delete('list')
    infinite.isLoading = true
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    cleanup()
    infinite.isLoading = false
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    expect(screen.getByText('No labels yet. Tag pods in Tag photos.')).toBeTruthy()
  })

  it('opens a crop\'s photo in the tagger, fetching one older than the history, or says when it is gone', () => {
    data.set('frames:upper', [frame('upper', 0)])
    data.set('frames:lower', [frame('lower', 0), frame('lower', 1)])
    data.set('list', [entry('lower-1', 'lower', 20, 'ready'), entry('upper-9', 'upper', 2, 'seeded'), entry('upper-gone', 'upper', 4, 'seeded', { url: null }), entry('upper-8', 'upper', 6, 'seeded')])
    data.set('capture:upper-9', frame('upper', 9))
    data.set('labels:upper-9', [label('upper-9', 2, 'seeded')])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    expect((screen.getByRole('button', { name: /^Open pod 4 / }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Open pod 20 / }))
    expect(screen.getByRole('tab', { name: 'Lower' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/lower-1.jpg')
    expect((screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Newer photo' }))
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/lower-0.jpg')

    expect(calls.get).not.toHaveBeenCalled()

    // Older than the history: fetched by id, and taps label that capture.
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    fireEvent.click(screen.getByRole('button', { name: /^Open pod 2 / }))
    expect(screen.getByRole('tab', { name: 'Upper' }).getAttribute('aria-selected')).toBe('true')
    expect(calls.get).toHaveBeenLastCalledWith({ id: 'upper-9' })
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/upper-9.jpg')
    expect(screen.getByText(`Older than the last ${HISTORY} photos: the arrows go back to them.`)).toBeTruthy()
    expect(pod(2).getAttribute('aria-label')).toBe('Pod 2: seeded')
    fireEvent.click(chip('Growing'))
    fireEvent.click(pod(5))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-9', slot: 5, label: 'growing' })
    expect((screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Newer photo' }))
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/upper-0.jpg')

    // Pruned since the list was loaded: the newest is shown, and it says why.
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    fireEvent.click(screen.getByRole('button', { name: /^Open pod 6 / }))
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/upper-0.jpg')
    expect(screen.getByText('That photo is no longer kept, so the newest is shown.')).toBeTruthy()
  })

  it('shapes each crop like its still once the still loads', () => {
    data.set('list', [entry('upper-1', 'upper', 3, 'seeded'), { ...entry('demo', 'upper', 4, 'seeded'), url: 'data:image/svg+xml;utf8,<svg/>' }])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    const box = boxes('upper')[3] as { w: number, h: number }
    const [crop, demo] = screen.getAllByRole('img') as HTMLImageElement[]
    expect(demo?.src).toMatch(/^data:image\/svg/)
    const tile = (crop as HTMLImageElement).parentElement as HTMLElement
    expect(parseFloat(tile.style.aspectRatio)).toBeCloseTo((box.w / box.h) * 4 / 3)
    Object.defineProperty(crop, 'naturalWidth', { value: 1600 })
    Object.defineProperty(crop, 'naturalHeight', { value: 900 })
    fireEvent.load(crop as HTMLImageElement)
    expect(parseFloat(tile.style.aspectRatio)).toBeCloseTo((box.w / box.h) * 16 / 9)
  })
})

describe('LabelPods suggestions (#261)', () => {
  const FROM = '2026-11-13T10:00:00Z'
  const hint = (slot: number, l: string, by: string, more: Record<string, unknown> = {}) => ({ slot, label: l, by, confidence: null, from: null, ...more })
  const hints = [hint(2, 'sprouted', 'carry', { from: FROM }), hint(3, 'growing', 'pod-state@1', { confidence: 0.86 }), hint(4, 'seeded', 'record'), hint(5, 'ready', 'carry', { from: FROM })]
  const accept = () => screen.getByRole('button', { name: /^Accept all/ })
  beforeEach(() => {
    data.set('frames:upper', [frame('upper', 0)])
    data.set('hints:upper-0', hints)
    data.set('labels:upper-0', [label('upper-0', 5, 'growing')])
  })

  it('shows a suggestion dashed with ? and says where it came from, until a label replaces it', () => {
    render(<LabelPods boxes={boxes} />)
    expect(pod(2).textContent).toBe('2 · sprouted?')
    expect(pod(2).getAttribute('aria-label')).toBe('Pod 2: suggested sprouted')
    expect(pod(2).getAttribute('aria-pressed')).toBe('false')
    expect(pod(2).className).toContain('border-dashed')
    expect(pod(2).getAttribute('data-suggested')).toBe('sprouted')
    expect(pod(2).getAttribute('title')).toBe(`Suggested sprouted: last labelled sprouted on ${new Date(FROM).toLocaleDateString([], { day: 'numeric', month: 'short' })}. ${NOT_VISIBLE}`)
    expect(pod(3).getAttribute('title')).toBe(`Suggested growing: pod-state 86%. ${NOT_VISIBLE}`)
    expect(pod(4).getAttribute('title')).toBe(`Suggested seeded: the pod record says seeded. ${NOT_VISIBLE}`)
    expect(NOT_VISIBLE).toContain('Analysis → Teach → Pod bounds → Adjust boxes')
    // A saved label replaces its suggestion.
    expect(pod(5).textContent).toBe('5 · growing')
    expect(pod(5).className).toContain('border-solid')
    expect(pod(5).getAttribute('title')).toBeNull()
    expect(pod(1).getAttribute('aria-label')).toBe('Pod 1: not labelled')
    expect(pod(1).getAttribute('title')).toBeNull()
    // Side by side, a suggestion is its pod's number and a question mark.
    data.set('frames:lower', [{ ...frame('lower', 0), ts: '2026-11-09T10:00:20Z' }])
    fireEvent.click(screen.getByRole('tab', { name: 'Both' }))
    expect(pod(2).textContent).toBe('2?')
  })

  it('accepts a suggestion with a tap when no label is picked, and saves another label over it when one is', () => {
    render(<LabelPods boxes={boxes} />)
    expect(within(screen.getByRole('group', { name: 'Label to apply' })).getAllByRole('button').every(b => b.getAttribute('aria-pressed') === 'false')).toBe(true)
    fireEvent.click(pod(2))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 2, label: 'sprouted' })
    expect(pod(2).getAttribute('aria-label')).toBe('Pod 2: sprouted')
    // With no label picked, a labelled pod or one with no suggestion is left alone.
    calls.setLabel.mockReset()
    fireEvent.click(pod(2))
    fireEvent.click(pod(5))
    fireEvent.click(pod(1))
    expect(calls.setLabel).not.toHaveBeenCalled()
    // Another label picked: the unit saves it as corrected, keeping the suggestion.
    fireEvent.click(chip('Ready'))
    fireEvent.click(pod(3))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 3, label: 'ready' })
    expect(pod(3).getAttribute('aria-label')).toBe('Pod 3: ready')
    // Tapping the picked chip again puts it down, back to accepting.
    fireEvent.click(chip('Ready'))
    expect(chip('Ready').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pod(4))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 4, label: 'seeded' })
  })

  it('accepts all of a photo\'s suggestions in one go, and never saves a pod without one', () => {
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(pod(2))
    expect(accept().textContent).toBe('Accept all 2')
    fireEvent.click(accept())
    expect(calls.accept).toHaveBeenCalledWith({ captureId: 'upper-0', slots: [3, 4] })
    expect(invalidate).toHaveBeenCalled()
    expect([3, 4].map(s => pod(s).getAttribute('aria-label'))).toEqual(['Pod 3: growing', 'Pod 4: seeded'])
    expect(pod(5).getAttribute('aria-label')).toBe('Pod 5: growing')
    // The untouched pods with no suggestion stay unlabelled, and nothing is left to accept.
    expect(pod(1).getAttribute('aria-label')).toBe('Pod 1: not labelled')
    expect(calls.setLabel).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/ · upper · 4 of 15 labelled$/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Accept all/ })).toBeNull()
    expect(screen.getByText('Nothing suggested waits here. Pick a label and tap pods to tag them.')).toBeTruthy()
  })

  it('accepts only the pods shown, on each photo of a round', () => {
    // Pod 4's box was removed: its suggestion isn't shown, so Accept all leaves it.
    const without4 = (c: 'upper' | 'lower') => Object.fromEntries(Object.entries(podRegions(c)).filter(([s]) => s !== '4'))
    data.set('frames:lower', [{ ...frame('lower', 0), ts: '2026-11-09T10:00:20Z' }])
    data.set('hints:lower-0', [hint(16, 'empty', 'record')])
    render(<LabelPods boxes={without4} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Both' }))
    expect(screen.getByRole('region', { name: 'Suggestions' }).textContent).toContain('Suggestions on these photos3')
    fireEvent.click(accept())
    expect(calls.accept.mock.calls).toEqual([[{ captureId: 'upper-0', slots: [2, 3] }], [{ captureId: 'lower-0', slots: [16] }]])
    expect(pod(16).getAttribute('aria-label')).toBe('Pod 16: empty')
  })

  it('says what the photo\'s suggestions are and how often their suggesters were right', () => {
    data.set('stats', { ...stats, sources: { picked: 3, accepted: 7, corrected: 2 }, suggesters: [{ by: 'carry', accepted: 6, corrected: 1, right: 0.857 }, { by: 'pod-state@1', accepted: 1, corrected: 1, right: 0.5 }] })
    render(<LabelPods boxes={boxes} />)
    const card = screen.getByRole('region', { name: 'Suggestions' })
    expect(card.textContent).toContain('Suggestions on this photo3')
    // Pod 5 is labelled, so its suggestion doesn't wait.
    expect(within(card).getByTestId('suggestion-breakdown').textContent).toBe('1 seeded, 1 sprouted, 1 growing.')
    expect(within(card).getByTestId('suggestion-sources').textContent).toBe('carry 86% right · pod-state 50% right · record not checked yet')
  })

  it('reviews one by one from the first dashed pod, accepting with each tap', () => {
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(chip('Ready'))
    fireEvent.click(screen.getByRole('button', { name: 'Review one by one' }))
    expect(chip('Ready').getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(pod(2))
    fireEvent.click(pod(2))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 2, label: 'sprouted' })
  })

  it('puts the suggestions back when the unit refuses Accept all, and says why', () => {
    mutation.acceptFail = true
    mutation.acceptError = { message: 'no capture upper-0' }
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(accept())
    expect(pod(2).getAttribute('aria-label')).toBe('Pod 2: suggested sprouted')
    expect(screen.getByText('no capture upper-0')).toBeTruthy()
  })
})

describe('LabelPods dismissed suggestions (#261)', () => {
  const hint = (slot: number, l: string) => ({ slot, label: l, by: 'record', confidence: null, from: null })
  const accept = () => screen.queryByRole('button', { name: /^Accept all/ })
  const lowerPod = (slot: number) => screen.getByRole('button', { name: new RegExp(`^Pod ${slot}:`) })
  beforeEach(() => {
    data.set('frames:lower', [frame('lower', 0)])
    data.set('hints:lower-0', [hint(22, 'seeded'), hint(25, 'seeded'), hint(28, 'seeded'), hint(29, 'seeded')])
    data.set('labels:lower-0', [{ ...label('lower-0', 20, 'growing'), camera: 'lower' }])
  })
  const lower = () => fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))

  it('dismisses a suggestion with Clear, hiding its tag, and brings it back with Clear again', () => {
    render(<LabelPods boxes={boxes} />)
    lower()
    expect(lowerPod(28).textContent).toBe('28 · seeded?')
    fireEvent.click(chip('Clear'))
    fireEvent.click(lowerPod(28))
    expect(calls.dismiss).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 28 })
    expect(calls.setLabel).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalled()
    // The tag disappears, and the box says how to undo it.
    expect(lowerPod(28).textContent).toBe('28')
    expect(lowerPod(28).getAttribute('data-suggested')).toBeNull()
    expect(lowerPod(28).getAttribute('data-dismissed')).toBe('true')
    expect(lowerPod(28).getAttribute('aria-label')).toBe('Pod 28: suggestion dismissed')
    expect(lowerPod(28).getAttribute('title')).toBe('Suggestion dismissed on this photo. Tap with Clear to bring it back.')
    expect(accept()?.textContent).toBe('Accept all 3')

    fireEvent.click(lowerPod(28))
    expect(calls.restore).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 28 })
    expect(lowerPod(28).textContent).toBe('28 · seeded?')
    expect(lowerPod(28).getAttribute('data-dismissed')).toBeNull()
    expect(accept()?.textContent).toBe('Accept all 4')
    // Clear on a pod with neither a label nor a suggestion does nothing.
    fireEvent.click(lowerPod(16))
    expect(calls.dismiss).toHaveBeenCalledTimes(1)
    expect(calls.restore).toHaveBeenCalledTimes(1)
  })

  it('reads dismissals from the unit, so a reload keeps them, and Accept all skips them', () => {
    data.set('dismissed:lower-0', [{ slot: 28, dismissedAt: '2026-11-14T10:00:00Z' }, { slot: 29, dismissedAt: '2026-11-14T10:00:01Z' }])
    render(<LabelPods boxes={boxes} />)
    lower()
    expect(lowerPod(28).textContent).toBe('28')
    expect(lowerPod(29).getAttribute('aria-label')).toBe('Pod 29: suggestion dismissed')
    // A tap with no label picked doesn't accept a dismissed suggestion.
    fireEvent.click(lowerPod(28))
    expect(calls.setLabel).not.toHaveBeenCalled()
    expect(accept()?.textContent).toBe('Accept all 2')
    fireEvent.click(accept() as HTMLElement)
    expect(calls.accept).toHaveBeenCalledWith({ captureId: 'lower-0', slots: [22, 25] })
    expect([22, 25].map(s => lowerPod(s).getAttribute('aria-label'))).toEqual(['Pod 22: seeded', 'Pod 25: seeded'])
    expect([28, 29].map(s => lowerPod(s).getAttribute('aria-label'))).toEqual(['Pod 28: suggestion dismissed', 'Pod 29: suggestion dismissed'])
    // A label picked on a dismissed pod still saves.
    fireEvent.click(chip('Empty'))
    fireEvent.click(lowerPod(29))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 29, label: 'empty' })
    expect(lowerPod(29).getAttribute('aria-label')).toBe('Pod 29: empty')
    expect(lowerPod(29).getAttribute('data-dismissed')).toBeNull()
  })

  it('still takes a saved label off with Clear, not dismissing anything', () => {
    render(<LabelPods boxes={boxes} />)
    lower()
    fireEvent.click(chip('Clear'))
    fireEvent.click(lowerPod(20))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 20, label: null })
    expect(calls.dismiss).not.toHaveBeenCalled()
    expect(lowerPod(20).getAttribute('aria-label')).toBe('Pod 20: not labelled')
  })

  it('forgets an unsaved dismissal on another photo, and puts the tag back when the unit refuses', () => {
    data.set('frames:lower', [frame('lower', 0), frame('lower', 1)])
    render(<LabelPods boxes={boxes} />)
    lower()
    fireEvent.click(chip('Clear'))
    fireEvent.click(lowerPod(22))
    expect(lowerPod(22).textContent).toBe('22')
    fireEvent.click(screen.getByRole('button', { name: 'Older photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Newer photo' }))
    // Taps shown ahead of the unit go with the photo; back on it, the unit's list (empty here) decides.
    expect(lowerPod(22).textContent).toBe('22 · seeded?')
    cleanup()

    mutation.dismissFail = true
    mutation.dismissError = { message: 'pod 22 is not on the upper camera' }
    render(<LabelPods boxes={boxes} />)
    lower()
    fireEvent.click(chip('Clear'))
    fireEvent.click(lowerPod(22))
    expect(lowerPod(22).textContent).toBe('22 · seeded?')
    expect(screen.getByText('pod 22 is not on the upper camera')).toBeTruthy()
    // A refused restore keeps the dismissal shown.
    data.set('dismissed:lower-0', [{ slot: 25, dismissedAt: '2026-11-14T10:00:00Z' }])
    mutation.dismissError = null
    mutation.restoreError = { message: 'no capture lower-0' }
    cleanup()
    render(<LabelPods boxes={boxes} />)
    lower()
    fireEvent.click(chip('Clear'))
    fireEvent.click(lowerPod(25))
    expect(calls.restore).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 25 })
    expect(lowerPod(25).getAttribute('aria-label')).toBe('Pod 25: suggestion dismissed')
    expect(screen.getByText('no capture lower-0')).toBeTruthy()
  })

  it('says which boxes look off their pod, and opens the boxes to adjust', () => {
    const edit = vi.fn()
    const { rerender } = render(<LabelPods boxes={boxes} onEditBoxes={edit} />)
    const card = () => screen.getByRole('region', { name: 'Pod bounds' })
    expect(within(card()).getByTestId('bounds-summary').textContent).toBe('No box looks off its pod.')
    rerender(<LabelPods boxes={boxes} onEditBoxes={edit} boxesOff={[{ camera: 'lower', slot: 27, photos: 2 }, { camera: 'lower', slot: 28, photos: 4 }]} />)
    expect(within(card()).getByTestId('bounds-summary').textContent).toBe('2 boxes look off their pods (27, 28)')
    rerender(<LabelPods boxes={boxes} onEditBoxes={edit} boxesOff={[{ camera: 'lower', slot: 28, photos: 4 }]} />)
    expect(within(card()).getByTestId('bounds-summary').textContent).toBe('1 box looks off its pod (28)')
    fireEvent.click(within(card()).getByRole('button', { name: 'Adjust boxes' }))
    expect(edit).toHaveBeenCalledTimes(1)
  })
})
