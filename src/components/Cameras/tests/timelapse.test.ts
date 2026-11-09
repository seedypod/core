// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FrameCache } from '../frameCache'
import { FrameLoader, LOOKAHEAD, nextSpeed, SPEEDS, type TimelapseFrame, useTimelapse } from '../timelapse'

const frames = (n: number): TimelapseFrame[] => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, src: `/api/captures/f${i}.jpg` }))

let load: ReturnType<typeof vi.fn<(key: string, url: string) => Promise<Blob>>>
let broken: Set<string>
let revoked: string[]
const fakeCache = () => ({ load }) as unknown as FrameCache

beforeEach(() => {
  broken = new Set()
  revoked = []
  load = vi.fn(async (key: string) => {
    if (broken.has(key)) throw new Error(`${key} gone`)
    return new Blob([key], { type: 'image/jpeg' })
  })
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:test/${n++}`)
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u))
})
afterEach(() => vi.useRealTimers())

describe('nextSpeed', () => {
  it('cycles through the speeds and back', () => {
    expect(SPEEDS.map(nextSpeed)).toEqual([...SPEEDS.slice(1), SPEEDS[0]])
  })
})

describe('FrameLoader', () => {
  it('loads frames through the cache and lets go of the ones no longer wanted', async () => {
    const l = new FrameLoader(fakeCache())
    const f = frames(4)
    const seen = vi.fn()
    const off = l.subscribe(seen)
    l.sync(f.slice(0, 2), [])
    l.sync(f.slice(0, 2), []) // already on its way: not fetched twice
    await vi.waitFor(() => expect(l.url('f1')).toBeDefined())
    expect(load.mock.calls.map(c => c[0])).toEqual(['f0', 'f1'])
    expect(l.getVersion()).toBe(2)
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    const f0 = l.url('f0')
    l.sync(f.slice(2, 4), f.slice(1, 2))
    expect(revoked).toEqual([f0])
    expect(l.url('f0')).toBeUndefined()
    expect(l.url('f1')).toBeDefined()
  })

  it('uses data URLs as they are, and never revokes them', () => {
    const l = new FrameLoader(fakeCache())
    const demo = { id: 'd', src: 'data:image/svg+xml,<svg/>' }
    l.sync([demo], [])
    expect(l.url('d')).toBe(demo.src)
    expect(load).not.toHaveBeenCalled()
    l.sync([], [])
    expect(l.url('d')).toBeUndefined()
    expect(revoked).toEqual([])
  })

  it('skips frames that failed to load', async () => {
    broken.add('f1')
    const l = new FrameLoader(fakeCache())
    const f = frames(3)
    l.sync(f, [])
    await vi.waitFor(() => expect(l.url('f2')).toBeDefined())
    expect(l.nextPlayable(f, 1)).toBe(2)
    expect(l.nextPlayable(f, 3)).toBe(-1)
    l.sync(f, [])
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('drops loads that land after it was cleared', async () => {
    let finish: (b: Blob) => void = () => undefined
    load.mockImplementationOnce(() => new Promise<Blob>((resolve) => {
      finish = resolve
    }))
    broken.add('f1')
    const l = new FrameLoader(fakeCache())
    l.sync(frames(2), [])
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    l.clear()
    finish(new Blob(['late']))
    await vi.waitFor(() => expect(l.getVersion()).toBe(2))
    expect(l.url('f0')).toBeUndefined()
    expect(l.nextPlayable(frames(2), 0)).toBe(0)
  })
})

describe('useTimelapse', () => {
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

  it('follows the newest frame until played', () => {
    const { result } = renderHook(() => useTimelapse(frames(3), fakeCache()))
    expect(result.current.index).toBeNull()
    expect(result.current.playing).toBe(false)
    expect(result.current.src({ id: 'f2', src: '/api/captures/f2.jpg' })).toBe('/api/captures/f2.jpg')
  })

  it('plays from the oldest frame to the newest at the chosen speed, then stops', async () => {
    vi.useFakeTimers()
    const f = frames(3)
    const { result } = renderHook(() => useTimelapse(f, fakeCache()))
    act(() => result.current.toggle())
    expect(result.current.playing).toBe(true)
    await tick(0)
    expect(result.current.waiting).toBe(false)
    expect(load).toHaveBeenCalledTimes(3)
    await tick(1000 / SPEEDS[1])
    expect(result.current.index).toBe(0)
    expect(result.current.src({ id: 'f0', src: '' })).toMatch(/^blob:/)
    act(() => result.current.cycleSpeed())
    expect(result.current.speed).toBe(SPEEDS[2])
    await tick(1000 / SPEEDS[2])
    expect(result.current.index).toBe(1)
    await tick(1000 / SPEEDS[2])
    expect(result.current.index).toBe(2)
    expect(result.current.playing).toBe(false)
    // Played again from the start.
    act(() => result.current.toggle())
    await tick(1000 / SPEEDS[2])
    expect(result.current.index).toBe(0)
  })

  it('waits for a frame that has not loaded yet', async () => {
    vi.useFakeTimers()
    let finish: (b: Blob) => void = () => undefined
    load.mockImplementationOnce(() => new Promise<Blob>((resolve) => {
      finish = resolve
    }))
    const { result } = renderHook(() => useTimelapse(frames(2), fakeCache()))
    act(() => result.current.toggle())
    await tick(2000)
    expect(result.current.waiting).toBe(true)
    expect(result.current.index).toBeNull()
    await act(async () => finish(new Blob(['f0'])))
    await tick(1000 / SPEEDS[1])
    expect(result.current.index).toBe(0)
  })

  it('pauses, resumes from the paused frame, and scrubs while playing', async () => {
    vi.useFakeTimers()
    const f = frames(LOOKAHEAD + 4)
    const { result } = renderHook(() => useTimelapse(f, fakeCache()))
    act(() => result.current.toggle())
    await tick(1000 / SPEEDS[1])
    expect(result.current.index).toBe(0)
    act(() => result.current.toggle())
    expect(result.current.playing).toBe(false)
    await tick(5000)
    expect(result.current.index).toBe(0)
    act(() => result.current.toggle())
    await tick(1000 / SPEEDS[1])
    expect(result.current.index).toBe(1)
    act(() => result.current.seek(6))
    expect(result.current.index).toBe(6)
    expect(result.current.playing).toBe(true)
    await tick(1000 / SPEEDS[1])
    expect(result.current.index).toBe(7)
    // Frames far behind the playhead were let go.
    expect(revoked.length).toBeGreaterThan(0)
    // Scrubbing while paused only moves the frame.
    act(() => result.current.toggle())
    act(() => result.current.seek(2))
    await tick(5000)
    expect(result.current.index).toBe(2)
    expect(result.current.playing).toBe(false)
  })

  it('releases its object URLs on unmount', async () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useTimelapse(frames(2), fakeCache()))
    act(() => result.current.toggle())
    await tick(0)
    unmount()
    expect(revoked).toHaveLength(2)
  })
})
