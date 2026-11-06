import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTrpcClient } from '../trpc'

const { lazyDemoLink } = vi.hoisted(() => ({ lazyDemoLink: vi.fn(() => () => () => ({ subscribe: () => ({ unsubscribe: () => undefined }) })) }))

vi.mock('@/src/demo/lazyLink', () => ({ lazyDemoLink }))

describe('createTrpcClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    lazyDemoLink.mockClear()
  })

  it('talks to the unit, and never touches the demo, in a normal build', () => {
    createTrpcClient()
    expect(lazyDemoLink).not.toHaveBeenCalled()
  })

  it('runs the demo\'s in-page server in a demo build', () => {
    vi.stubEnv('VITE_DEMO', '1')
    createTrpcClient()
    expect(lazyDemoLink).toHaveBeenCalledOnce()
  })
})
