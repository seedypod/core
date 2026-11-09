import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CAP_BYTES, FrameCache, frameCache } from '../frameCache'

const still = (n: number, fill = 1) => new Uint8Array(n).fill(fill)

let idb: IDBFactory
let clock: number
let fetch: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>
const cache = (o: { cap?: number } = {}) => new FrameCache({ idb: () => idb, fetch, now: () => ++clock, ...o })

beforeEach(() => {
  idb = new IDBFactory()
  clock = 0
  fetch = vi.fn(async (url: string) => new Response(still(Number(/(\d+)$/.exec(url)?.[1] ?? 100), url.length), { headers: { 'content-type': 'image/jpeg' } }))
})

describe('FrameCache', () => {
  it('fetches a still once, then serves it from IndexedDB', async () => {
    const c = cache()
    const first = await c.load('a', '/a/100')
    const again = await c.load('a', '/a/100')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(again.type).toBe('image/jpeg')
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(new Uint8Array(await first.arrayBuffer()))
    expect(c.bytes).toBe(100)
  })

  it('keeps stills across page loads', async () => {
    await cache().load('a', '/a/100')
    const revisit = cache()
    expect(await revisit.has('a')).toBe(true)
    await revisit.load('a', '/a/100')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('evicts the least recently shown stills past the cap', async () => {
    const c = cache({ cap: 250 })
    await c.load('a', '/a/100')
    await c.load('b', '/b/100')
    await c.load('a', '/a/100') // a is now newer than b
    await c.load('c', '/c/100')
    expect(await c.has('b')).toBe(false)
    expect(await c.has('a')).toBe(true)
    expect(await c.has('c')).toBe(true)
    expect(c.bytes).toBe(200)
    // The eviction reached the database, not just the in-memory index.
    const revisit = cache({ cap: 250 })
    expect(await revisit.has('b')).toBe(false)
    expect(revisit.bytes).toBe(200)
    await revisit.load('b', '/b/100')
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('returns a still bigger than the cap without keeping it', async () => {
    const c = cache({ cap: 50 })
    expect((await c.load('big', '/big/100')).size).toBe(100)
    expect(await c.has('big')).toBe(false)
    expect(c.bytes).toBe(0)
  })

  it('shares one fetch between overlapping loads of the same still', async () => {
    const c = cache()
    await Promise.all([c.load('a', '/a/100'), c.load('a', '/a/100')])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses an error response and keeps nothing', async () => {
    fetch.mockResolvedValueOnce(new Response('gone', { status: 404 }))
    const c = cache()
    await expect(c.load('a', '/a/100')).rejects.toThrow('/a/100 answered 404')
    expect(await c.has('a')).toBe(false)
    await c.load('a', '/a/100')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refetches a still whose stored copy went missing', async () => {
    const c = cache()
    await c.load('a', '/a/100')
    // Another tab (or the browser) removed the bytes behind this tab's index.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = idb.open('seedypod-frames', 1)
      r.onsuccess = () => resolve(r.result)
    })
    await new Promise<void>((resolve) => {
      const tx = db.transaction('blobs', 'readwrite')
      tx.objectStore('blobs').delete('a')
      tx.oncomplete = () => resolve()
    })
    db.close()
    expect((await c.load('a', '/a/100')).size).toBe(100)
    expect(fetch).toHaveBeenCalledTimes(2)
    await c.load('a', '/a/100')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to the network when IndexedDB is missing or blocked', async () => {
    for (const idbGetter of [() => undefined, () => {
      throw new DOMException('blocked', 'SecurityError')
    }]) {
      fetch.mockClear()
      const c = new FrameCache({ idb: idbGetter, fetch })
      await c.load('a', '/a/100')
      await c.load('a', '/a/100')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(await c.has('a')).toBe(false)
    }
  })

  it('still returns a frame it could not store', async () => {
    const unreadable = { size: 10, type: 'image/jpeg', arrayBuffer: () => Promise.reject(new Error('quota')) } as unknown as Blob
    fetch.mockResolvedValueOnce({ ok: true, blob: async () => unreadable } as Response)
    const c = cache()
    expect(await c.load('a', '/a/10')).toBe(unreadable)
    expect(await c.has('a')).toBe(false)
  })

  it('has one shared instance with the default cap', () => {
    expect(frameCache()).toBe(frameCache())
    expect(frameCache().cap).toBe(CACHE_CAP_BYTES)
  })
})
