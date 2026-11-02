import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLiveDocsIndex, resetLiveDocsIndex } from '../docsIndex'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  resetLiveDocsIndex()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('loadLiveDocsIndex', () => {
  it('gives up after 3 s when the docs site does not answer', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const live = loadLiveDocsIndex()
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(live).resolves.toBeNull()
  })
})
