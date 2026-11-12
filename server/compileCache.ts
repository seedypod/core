import { flushCompileCache } from 'node:module'

/**
 * Node otherwise writes NODE_COMPILE_CACHE only at a clean exit, which a unit that gets
 * unplugged never has. Once start-up has compiled what it needs, and a cache that's
 * already there writes nothing.
 */
export function flushCompileCacheSoon(flush: () => void = flushCompileCache): void {
  setTimeout(flush, 60_000).unref()
}
