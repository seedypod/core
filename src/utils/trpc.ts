import { QueryClient } from '@tanstack/react-query'
import { httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client'
import { createTRPCReact } from '@trpc/react-query'
import superjson from 'superjson'
import type { AppRouter } from '@/src/server/routers/app'
import { lazyDemoLink } from '@/src/demo/lazyLink'

export const trpc = createTRPCReact<AppRouter>()

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1 },
  },
})

export function apiBase(): string {
  return import.meta.env.VITE_API_BASE ?? ''
}

export function createTrpcClient() {
  // Spelled out, not isDemo(), so a unit's build folds this away and drops the demo with it.
  if (import.meta.env.VITE_DEMO === '1') {
    return trpc.createClient({ links: [lazyDemoLink()] })
  }
  return trpc.createClient({
    links: [
      splitLink({
        condition: op => op.type === 'subscription',
        true: httpSubscriptionLink({ url: `${apiBase()}/api/trpc`, transformer: superjson }),
        false: httpBatchLink({ url: `${apiBase()}/api/trpc`, transformer: superjson }),
      }),
    ],
  })
}
