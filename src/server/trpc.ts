import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import type { OpenApiMeta } from 'trpc-to-openapi'
import type { Context } from './context'

// allowOutsideOfServer: the browser demo runs the router in-page (src/demo/link.ts).
const t = initTRPC.context<Context>().meta<OpenApiMeta>().create({ transformer: superjson, allowOutsideOfServer: true })

/** LAN-only trust model (ADR-0012): no auth, every procedure is public. */
export const publicProcedure = t.procedure
export const router = t.router
export const createCallerFactory = t.createCallerFactory
