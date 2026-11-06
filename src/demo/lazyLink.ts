import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '../server/routers/app'

/**
 * The demo link, fetched on first use, so its in-page server (SimHal, every
 * router, zod) isn't in the main bundle. A top-level await would be shorter,
 * but it makes Rollup break the entry into dozens of small files.
 */
export function lazyDemoLink(): TRPCLink<AppRouter> {
  const loaded = import('./link').then(m => m.demoLink())
  return runtime => args => observable((observer) => {
    let stop: (() => void) | undefined
    let stopped = false
    loaded.then((link) => {
      if (!stopped) stop = link(runtime)(args).subscribe(observer).unsubscribe
    }).catch(err => observer.error(TRPCClientError.from(err as Error)))
    return () => {
      stopped = true
      stop?.()
    }
  })
}
