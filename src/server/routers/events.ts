import { publicProcedure, router } from '../trpc'
import type { CoreEvent } from '../../lib/eventBus'

export const eventsRouter = router({
  /** Live feed for the UI (tRPC subscription over SSE). */
  onChange: publicProcedure.subscription(async function* ({ ctx, signal }) {
    const queue: CoreEvent[] = []
    let wake: (() => void) | null = null
    const unsub = ctx.events.subscribe((e) => {
      queue.push(e)
      wake?.()
    })
    try {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          wake = null
        }
        while (queue.length) yield queue.shift() as CoreEvent
      }
    }
    finally {
      unsub()
    }
  }),
})
