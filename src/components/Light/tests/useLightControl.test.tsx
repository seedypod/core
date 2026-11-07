// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import type { TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppRouter } from '@/src/server/routers/app'
import { queryClient, trpc } from '@/src/utils/trpc'
import { useLightControl } from '../useLightControl'

const state = (level: number) => ({ on: true, level, since: '2026-11-06T10:00:00Z', fault: null, remainingS: null })

/** The real hook, cache and mutation callbacks over a link the test answers by hand. */
function harness() {
  const replies: Array<(level: number) => void> = []
  const link: TRPCLink<AppRouter> = () => ({ op }) => observable((observer) => {
    const answer = (level: number) => {
      observer.next({ result: { type: 'data', data: state(level) } })
      observer.complete()
    }
    if (op.type === 'mutation') replies.push(answer)
    else answer(40)
  })
  const client = trpc.createClient({ links: [link] })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
  return { replies, ...renderHook(() => useLightControl(), { wrapper }) }
}

describe('useLightControl through the real query cache', () => {
  beforeEach(() => queryClient.clear())
  afterEach(cleanup)

  it('keeps the newest command\'s level when the replies arrive out of order', async () => {
    const { replies, result } = harness()
    await waitFor(() => expect(result.current.light?.level).toBe(40))
    act(() => result.current.commit(30))
    act(() => result.current.commit(60))
    await waitFor(() => expect(replies).toHaveLength(2))
    await act(async () => replies[1]?.(60))
    await waitFor(() => expect(result.current.light?.level).toBe(60))
    await act(async () => replies[0]?.(30))
    await act(() => new Promise(r => setTimeout(r, 20)))
    expect(result.current.light?.level).toBe(60)
    expect(result.current.level).toBe(60)
  })

  it('takes each reply when commands don\'t overlap', async () => {
    const { replies, result } = harness()
    await waitFor(() => expect(result.current.light?.level).toBe(40))
    act(() => result.current.commit(30))
    await waitFor(() => expect(replies).toHaveLength(1))
    await act(async () => replies[0]?.(30))
    await waitFor(() => expect(result.current.light?.level).toBe(30))
    act(() => result.current.commit(60))
    await waitFor(() => expect(replies).toHaveLength(2))
    await act(async () => replies[1]?.(60))
    await waitFor(() => expect(result.current.light?.level).toBe(60))
  })
})
