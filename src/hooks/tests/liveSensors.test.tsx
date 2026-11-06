// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import type { TRPCClientError } from '@trpc/client'
import { type TRPCLink } from '@trpc/client'
import { observable, type Observer } from '@trpc/server/observable'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppRouter } from '@/src/server/routers/app'
import type { CoreEvent } from '@/src/lib/eventBus'
import { queryClient, trpc } from '@/src/utils/trpc'
import { BURST_MS, useLiveEvents } from '../useLiveEvents'

const reading = (value: number, ts: string) => ({ ts, value, unit: '°C', quality: 'good' })

/** The real cache, hook and query options over a link the test answers by hand. */
function harness() {
  const fetches: Array<(data: unknown) => void> = []
  const stream: { to: Observer<unknown, TRPCClientError<AppRouter>> | null } = { to: null }
  const link: TRPCLink<AppRouter> = () => ({ op }) => observable((observer) => {
    if (op.type === 'subscription') stream.to = observer as typeof stream.to
    else fetches.push((data) => {
      observer.next({ result: { type: 'data', data } })
      observer.complete()
    })
  })
  const client = trpc.createClient({ links: [link] })
  function Show() {
    useLiveEvents()
    const latest = trpc.sensors.latest.useQuery()
    return <div data-testid="air">{latest.data?.air_temp?.value ?? 'none'}</div>
  }
  const Wrap = ({ children }: { children: ReactNode }) => (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
  render(<Wrap><Show /></Wrap>)
  const event = (e: CoreEvent) => act(() => stream.to?.next({ result: { type: 'data', data: e } } as never))
  return { fetches, event }
}

const tick = (id: string, r: unknown): CoreEvent => ({ kind: 'hal', event: { type: 'sensor', id, reading: r } }) as CoreEvent
const shown = () => screen.getByTestId('air').textContent
const settle = () => act(() => new Promise(r => setTimeout(r, BURST_MS + 20)))

describe('live sensors through the real query cache', () => {
  beforeEach(() => queryClient.clear())
  afterEach(cleanup)

  it('shows a reading from the event without another request', async () => {
    const { fetches, event } = harness()
    await waitFor(() => expect(fetches).toHaveLength(1))
    await act(async () => fetches[0]?.({ air_temp: reading(20, '2026-11-06T10:00:00Z') }))
    await waitFor(() => expect(shown()).toBe('20'))
    event(tick('air_temp', reading(21, '2026-11-06T10:00:10Z')))
    await settle()
    expect(shown()).toBe('21')
    expect(fetches).toHaveLength(1)
  })

  it('keeps a reading that landed while a slower fetch was in flight', async () => {
    const { fetches, event } = harness()
    await waitFor(() => expect(fetches).toHaveLength(1))
    await act(async () => fetches[0]?.({ air_temp: reading(20, '2026-11-06T10:00:00Z') }))
    await waitFor(() => expect(shown()).toBe('20'))
    await act(async () => void queryClient.refetchQueries())
    await waitFor(() => expect(fetches).toHaveLength(2))
    event(tick('air_temp', reading(22, '2026-11-06T10:00:20Z')))
    await settle()
    expect(shown()).toBe('22')
    await act(async () => fetches[1]?.({ air_temp: reading(21, '2026-11-06T10:00:10Z') }))
    await settle()
    expect(shown()).toBe('22')
  })

  it('ignores an event older than what the cache holds', async () => {
    const { fetches, event } = harness()
    await waitFor(() => expect(fetches).toHaveLength(1))
    await act(async () => fetches[0]?.({ air_temp: reading(20, '2026-11-06T10:00:10Z') }))
    await waitFor(() => expect(shown()).toBe('20'))
    event(tick('air_temp', reading(19, '2026-11-06T10:00:00Z')))
    await settle()
    expect(shown()).toBe('20')
  })
})
