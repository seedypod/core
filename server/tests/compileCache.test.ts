import { describe, expect, it, vi } from 'vitest'
import { flushCompileCacheSoon } from '../compileCache'

describe('flushCompileCacheSoon', () => {
  it('flushes once, a minute after start-up, and never keeps the process alive', () => {
    vi.useFakeTimers()
    try {
      const flush = vi.fn()
      const unref = vi.spyOn(globalThis, 'setTimeout')
      flushCompileCacheSoon(flush)
      expect(unref).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(59_999)
      expect(flush).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(flush).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('uses Node\'s flush by default, which does nothing with no cache configured', () => {
    vi.useFakeTimers()
    try {
      flushCompileCacheSoon()
      vi.advanceTimersByTime(60_000)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
