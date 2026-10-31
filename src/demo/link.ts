/**
 * Browser demo: VITE_DEMO=1 routes every tRPC call to an in-page caller over
 * SimHal, so the Vercel preview runs the real UI against fake hardware
 * (sleepypod `src/demo/` pattern).
 */
import type { TRPCLink } from '@trpc/client'
import { TRPCClientError } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { SimHal } from '../hardware/sim'
import type { Context } from '../server/context'
import { createCore } from '../server/bootstrap'
import { MemoryStore } from '../store/memory'
import { seedDemo } from './seed'
import { appRouter, type AppRouter } from '../server/routers/app'
import { createCallerFactory } from '../server/trpc'

export function isDemo(): boolean {
  return import.meta.env.VITE_DEMO === '1'
}

let ctx: Context | null = null
function demoContext(): Context {
  if (!ctx) {
    const hal = new SimHal({ timeScale: 60, tickMs: 1000 })
    const store = new MemoryStore()
    seedDemo(store, hal)
    const core = createCore({ hal, store, version: 'demo', startServices: true, captureMinBytes: 1 })
    ctx = core.ctx
  }
  return ctx
}

export function demoLink(): TRPCLink<AppRouter> {
  const caller = createCallerFactory(appRouter)(demoContext())
  return () => ({ op }) => observable((observer) => {
    const parts = op.path.split('.')
    // Walk the caller to the procedure.
    let fn: unknown = caller
    for (const p of parts) fn = (fn as Record<string, unknown>)[p]
    if (typeof fn !== 'function') {
      observer.error(TRPCClientError.from(new Error(`demo: unknown procedure ${op.path}`)))
      return
    }
    if (op.type === 'subscription') {
      const unsub = demoContext().events.subscribe(e => observer.next({ result: { type: 'data', data: e } }))
      return () => unsub()
    }
    Promise.resolve((fn as (input: unknown) => Promise<unknown>)(op.input))
      .then((data) => {
        observer.next({ result: { type: 'data', data } })
        observer.complete()
      })
      .catch(err => observer.error(TRPCClientError.from(err as Error)))
    return () => undefined
  })
}
