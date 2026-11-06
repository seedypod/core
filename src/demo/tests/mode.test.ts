import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDemo } from '../mode'

describe('isDemo', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('follows VITE_DEMO', () => {
    expect(isDemo()).toBe(false)
    vi.stubEnv('VITE_DEMO', '1')
    expect(isDemo()).toBe(true)
  })
})
