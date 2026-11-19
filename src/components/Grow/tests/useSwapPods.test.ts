// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { swappedPods, useSwapPods } from '../useSwapPods'

interface Pod { slot: number, plant: string | null, status: string }

// The hook is its mutation's options; the pods cache is a plain value here.
const { cache } = vi.hoisted(() => ({ cache: { pods: undefined as Pod[] | undefined, cancel: vi.fn() } }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ grow: { pods: {
      cancel: cache.cancel,
      getData: () => cache.pods,
      setData: (_: undefined, v: Pod[] | ((p: Pod[] | undefined) => Pod[] | undefined)) => {
        cache.pods = typeof v === 'function' ? v(cache.pods) : v
      },
    } } }),
    grow: { swapPods: { useMutation: (o: unknown) => o } },
  },
}))

interface Options {
  onMutate: (i: { a: number, b: number }) => Promise<{ before: Pod[] | undefined }>
  onError: (e: unknown, i: { a: number, b: number }, ctx: { before: Pod[] | undefined } | undefined) => void
  onSuccess: (out: Pod[]) => void
}
const options = () => renderHook(() => useSwapPods()).result.current as unknown as Options

const basil = { slot: 1, plant: 'Basil', status: 'growing' }
const kale = { slot: 2, plant: 'Kale', status: 'seeded' }
const empty = { slot: 3, plant: null, status: 'empty' }

beforeEach(() => {
  cache.pods = [basil, kale, empty]
  cache.cancel.mockReset()
})

describe('swappedPods', () => {
  it('trades what two pods hold, each keeping its slot', () => {
    expect(swappedPods([basil, kale, empty], 1, 3)).toEqual([{ ...empty, slot: 1 }, kale, { ...basil, slot: 3 }])
  })

  it('leaves the pods alone for one pod, or one it doesn\'t know', () => {
    const pods = [basil, kale]
    expect(swappedPods(pods, 1, 1)).toBe(pods)
    expect(swappedPods(pods, 1, 9)).toBe(pods)
  })
})

describe('useSwapPods', () => {
  it('trades the cached records before the unit answers, then takes its answer', async () => {
    const o = options()
    const ctx = await o.onMutate({ a: 1, b: 2 })
    expect(cache.cancel).toHaveBeenCalled()
    expect(cache.pods?.map(p => p.plant)).toEqual(['Kale', 'Basil', null])
    expect(ctx.before?.map(p => p.plant)).toEqual(['Basil', 'Kale', null])
    // The unit's records replace the guesses, pod by pod.
    o.onSuccess([{ slot: 1, plant: 'Kale', status: 'growing' }, { slot: 2, plant: 'Basil', status: 'harvest' }])
    expect(cache.pods).toEqual([{ slot: 1, plant: 'Kale', status: 'growing' }, { slot: 2, plant: 'Basil', status: 'harvest' }, empty])
  })

  it('puts the records back when the swap fails', async () => {
    const o = options()
    const ctx = await o.onMutate({ a: 1, b: 3 })
    expect(cache.pods?.[0]?.plant).toBeNull()
    o.onError(new Error('no'), { a: 1, b: 3 }, ctx)
    expect(cache.pods).toEqual([basil, kale, empty])
  })

  it('writes nothing before the pods have loaded', async () => {
    cache.pods = undefined
    const o = options()
    const ctx = await o.onMutate({ a: 1, b: 2 })
    o.onError(new Error('no'), { a: 1, b: 2 }, ctx)
    o.onSuccess([kale])
    expect(cache.pods).toBeUndefined()
  })
})
