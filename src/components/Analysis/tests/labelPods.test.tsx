// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { podRegions } from '@/src/vision/regions'
import { HISTORY, LabelPods, moments, PAGE } from '../LabelPods'

const { data, calls, invalidate, mutation, infinite } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { frames: vi.fn(), labels: vi.fn(), setLabel: vi.fn(), labelList: vi.fn(), fetchNextPage: vi.fn() },
  invalidate: vi.fn(),
  mutation: { fail: false, error: null as null | { message: string } },
  infinite: { hasNextPage: false, isLoading: false },
}))

vi.mock('@/src/utils/trpc', () => ({
  apiBase: () => 'http://unit',
  trpc: {
    useUtils: () => ({ vision: { invalidate } }),
    camera: { list: { useQuery: (input: { camera: string }, opts?: { enabled?: boolean }) => {
      if (opts?.enabled !== false) calls.frames(input)
      return { data: opts?.enabled === false ? undefined : data.get(`frames:${input.camera}`) }
    } } },
    vision: {
      labels: { useQuery: (input: { captureId: string }, opts?: { enabled?: boolean }) => {
        calls.labels(input, opts)
        return { data: opts?.enabled === false ? undefined : data.get(`labels:${input.captureId}`) }
      } },
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
const chip = (name: string) => within(screen.getByRole('group', { name: 'Label to apply' })).getByRole('button', { name })
const boxes = (c: 'upper' | 'lower') => podRegions(c)
const stats = { counts: { empty: 4, seeded: 3, sprouted: 1, growing: 0, ready: 2, unhealthy: 1 }, pods: 11, captures: [] }

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  invalidate.mockReset()
  mutation.fail = false
  mutation.error = null
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
    expect(screen.getByTestId('count-empty').textContent).toBe('Empty 4')
    expect(screen.getByTestId('count-seeded').textContent).toBe('Seeded 3')
    expect(screen.getByTestId('count-unhealthy').textContent).toBe('Unhealthy 1')
    expect(screen.getByText('11 pods labelled')).toBeTruthy()
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/upper-0.jpg')
    expect(screen.getByTestId('label-pods-upper').querySelectorAll('button')).toHaveLength(15)
    expect(pod(2).getAttribute('aria-label')).toBe('Pod 2: sprouted')
    expect(pod(2).textContent).toBe('2 · sprouted')
    expect(pod(1).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(/1 of 15 pods labelled/)).toBeTruthy()
  })

  it('offers seeded between empty and sprouted, says what each label means, and how to remove one', () => {
    data.set('frames:upper', [frame('upper', 0)])
    render(<LabelPods boxes={boxes} />)
    const chips = within(screen.getByRole('group', { name: 'Label to apply' })).getAllByRole('button').map(b => b.textContent)
    expect(chips).toEqual(['Empty', 'Seeded', 'Sprouted', 'Growing', 'Ready', 'Unhealthy', 'Clear'])
    expect(chip('Empty').getAttribute('title')).toBe('Capped, no yCube')
    expect(chip('Seeded').getAttribute('title')).toBe('A yCube in, nothing visible yet')
    expect(screen.getByText('Tap a pod to tag it; tap again with the same label, or use Clear, to remove it.')).toBeTruthy()
    expect(screen.getByText(/Empty is capped, Seeded has a yCube/)).toBeTruthy()
    fireEvent.click(chip('Seeded'))
    fireEvent.click(pod(7))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 7, label: 'seeded' })
    expect(pod(7).getAttribute('aria-label')).toBe('Pod 7: seeded')
  })

  it('tags a pod with one tap, retags it with another label, and clears it with a second tap', () => {
    data.set('frames:upper', [frame('upper', 0)])
    render(<LabelPods boxes={boxes} />)
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
    expect(screen.getByText('0 pods labelled')).toBeTruthy()
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
    expect(screen.getByText(/1 of 30 pods labelled/)).toBeTruthy()
    // Side by side, the word doesn't fit a box: the fill says it.
    expect(pod(20).textContent).toBe('20')
    expect(pod(20).getAttribute('aria-label')).toBe('Pod 20: ready')

    fireEvent.click(pod(3))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 3, label: 'growing' })
    fireEvent.click(pod(16))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 16, label: 'growing' })
    expect(screen.getByText(/3 of 30 pods labelled/)).toBeTruthy()

    const older = screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement
    fireEvent.click(older)
    expect(screen.getAllByRole('img').map(i => (i as HTMLImageElement).alt)).toEqual(['upper camera at 2026-11-08T10:00:00Z', 'lower camera at 2026-11-08T10:00:20Z'])
    expect(pod(3).getAttribute('aria-label')).toBe('Pod 3: not labelled')
    fireEvent.click(older)
    // The lower camera has nothing that old.
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByText('No photos from this camera yet.')).toBeTruthy()
    expect(screen.getByText(/0 of 15 pods labelled/)).toBeTruthy()
    expect(older.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Newer photo' }))
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('groups stills into rounds of one per camera, newest first', () => {
    const f = (camera: 'upper' | 'lower', ts: string) => ({ ...frame(camera, 0), camera, ts })
    expect(moments([])).toEqual([])
    expect(moments([
      f('upper', '2026-11-09T10:00:00Z'), f('lower', '2026-11-09T10:00:20Z'),
      f('upper', '2026-11-09T09:00:00Z'), f('lower', '2026-11-09T09:00:20Z'),
      // A still taken by hand, far from a round, and two of one camera close together.
      f('upper', '2026-11-09T09:30:00Z'), f('upper', '2026-11-09T08:00:00Z'), f('upper', '2026-11-09T07:59:00Z'),
    ])).toEqual(['2026-11-09T10:00:20Z', '2026-11-09T09:30:00Z', '2026-11-09T09:00:20Z', '2026-11-09T08:00:00Z', '2026-11-09T07:59:00Z'])
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

  it('opens a crop\'s photo in the tagger, or says when it is older than the tagger reaches', () => {
    data.set('frames:upper', [frame('upper', 0)])
    data.set('frames:lower', [frame('lower', 0), frame('lower', 1)])
    data.set('list', [entry('lower-1', 'lower', 20, 'ready'), entry('upper-9', 'upper', 2, 'seeded'), entry('upper-gone', 'upper', 4, 'seeded', { url: null })])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    expect((screen.getByRole('button', { name: /^Open pod 4 / }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Open pod 20 / }))
    expect(screen.getByRole('tab', { name: 'Lower' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/lower-1.jpg')
    expect((screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Newer photo' }))
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/lower-0.jpg')

    fireEvent.click(screen.getByRole('tab', { name: 'All labels' }))
    fireEvent.click(screen.getByRole('button', { name: /^Open pod 2 / }))
    expect(screen.getByRole('tab', { name: 'Upper' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/upper-0.jpg')
    expect(screen.getByText(`That photo is older than the last ${HISTORY}, so the newest is shown.`)).toBeTruthy()
  })
})
