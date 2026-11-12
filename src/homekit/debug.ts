/**
 * A time-boxed window on hap-nodejs's own debug output: `HAP-NodeJS:*` on
 * hap-nodejs's copy of `debug`, written to core's log, off again by itself.
 * It shows what Home does over HAP (reads, writes, event subscriptions,
 * resource requests) on a running unit with no restart and no environment.
 *
 * hap-nodejs logs the SRTP keys of a live stream at this level. Core refuses
 * live streams (ADR 0027), so no key is ever generated.
 */
import { createRequire } from 'node:module'
import { format } from 'node:util'

export const HAP_NAMESPACES = 'HAP-NodeJS:*'
export const MAX_DEBUG_MINUTES = 60

/** The parts of the `debug` package this uses. */
export interface DebugModule {
  enable(namespaces: string): void
  disable(): string
  log: (...args: unknown[]) => void
}

/** hap-nodejs's own `debug`, resolved from its directory: pnpm doesn't hoist it, so core's could be another copy. */
export function hapDebugModule(resolveFrom: (spec: string, from: string) => string = (spec, from) => createRequire(from).resolve(spec)): DebugModule {
  const path = resolveFrom('debug', resolveFrom('hap-nodejs', import.meta.url))
  return createRequire(import.meta.url)(path) as DebugModule
}

export interface HapDebugOptions {
  log: (msg: string) => void
  load?: () => DebugModule
  now?: () => number
}

export class HapDebug {
  private timer: ReturnType<typeof setTimeout> | null = null
  private until: number | null = null
  private restore: { log: DebugModule['log'], namespaces: string } | null = null
  private mod: DebugModule | null = null
  private readonly now: () => number

  constructor(private readonly o: HapDebugOptions) {
    this.now = o.now ?? Date.now
  }

  /** When the window closes, as an ISO time; null while it's shut. */
  status(): { until: string | null } {
    return { until: this.until === null ? null : new Date(this.until).toISOString() }
  }

  /** Opens the window for `minutes` (clamped to 1–60) from now, or shuts it with 0. */
  set(minutes: number): { until: string | null } {
    if (minutes <= 0) {
      this.off('turned off')
      return this.status()
    }
    const mins = Math.min(MAX_DEBUG_MINUTES, Math.max(1, Math.round(minutes)))
    const mod = this.mod ??= (this.o.load ?? hapDebugModule)()
    if (!this.restore) {
      this.restore = { log: mod.log, namespaces: mod.disable() }
      mod.log = (...args: unknown[]) => this.o.log(`homekit debug: ${format(...args)}`)
      mod.enable(HAP_NAMESPACES)
    }
    if (this.timer) clearTimeout(this.timer)
    this.until = this.now() + mins * 60_000
    this.timer = setTimeout(() => this.off('window ended'), mins * 60_000)
    this.timer.unref?.()
    this.o.log(`homekit: HAP debug log on for ${mins} min`)
    return this.status()
  }

  /** Shuts the window; called on shutdown too. */
  off(why: string): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.until = null
    if (!this.restore || !this.mod) return
    this.mod.disable()
    this.mod.log = this.restore.log
    if (this.restore.namespaces) this.mod.enable(this.restore.namespaces)
    this.restore = null
    this.o.log(`homekit: HAP debug log off (${why})`)
  }
}
