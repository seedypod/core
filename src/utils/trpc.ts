import { QueryClient } from '@tanstack/react-query'
import { httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client'
import { createTRPCReact } from '@trpc/react-query'
import superjson from 'superjson'
import type { AppRouter } from '@/src/server/routers/app'
import { demoLink, isDemo } from '@/src/demo/link'

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
  if (isDemo()) {
    return trpc.createClient({ links: [demoLink()] })
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
