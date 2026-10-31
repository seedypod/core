import type { MiddlewareHandler } from 'hono'
import type { Store } from '../src/store/types'

/**
 * Optional API key (Phase 8.2). LAN-only trust is the default (ADR-0012):
 * with no key configured every request passes. When settings.apiKey is set,
 * non-loopback requests to /api/* must carry it as `X-API-Key` or
 * `Authorization: Bearer`. Loopback (the unit's own UI, cron, scripts) is
 * exempt, as in sleepypod and upstream garden-of-eden.
 */
export function apiKeyGuard(store: Store): MiddlewareHandler {
  return async (c, next) => {
    const key = store.settings.get().apiKey
    if (!key) return next()
    const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? c.req.header('x-forwarded-for') ?? ''
    if (isLoopback(addr)) return next()
    const given = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (authorize(key, addr, given)) return next()
    return c.json({ error: 'unauthorized' }, 401)
  }
}

/** Pure decision: no key configured ⇒ allow; loopback ⇒ allow; otherwise the presented key must match. */
export function authorize(configuredKey: string, remoteAddr: string, presented: string | undefined): boolean {
  if (!configuredKey) return true
  if (isLoopback(remoteAddr)) return true
  return !!presented && timingSafeEqual(presented, configuredKey)
}

export function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
