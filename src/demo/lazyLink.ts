import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '../server/routers/app'

/**
 * The demo link, fetched by the first operation, so its in-page server (SimHal, every
 * router, zod) isn't in the main bundle. A top-level await would be shorter,
 * but it makes Rollup break the entry into dozens of small files.
 */
export function lazyDemoLink(): TRPCLink<AppRouter> {
  let loading: Promise<TRPCLink<AppRouter>> | null = null
  // Forgets a failure, so the next operation tries again rather than failing for the life of the client.
  const load = () => (loading ??= import('./link').then(m => m.demoLink()).catch((err: unknown) => {
    loading = null
    throw err
  }))
  return runtime => args => observable((observer) => {
    let stop: (() => void) | undefined
    let stopped = false
    load().then((link) => {
      if (!stopped) stop = link(runtime)(args).subscribe(observer).unsubscribe
    }).catch(err => observer.error(TRPCClientError.from(err as Error)))
    return () => {
      stopped = true
      stop?.()
    }
  })
}
