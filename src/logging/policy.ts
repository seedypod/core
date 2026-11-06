/**
 * How much core logs (ported from sleepypod's recording_policy.py). The policy is
 * a small JSON file beside the database, which hald reads too: `quiet` keeps
 * warnings and errors, `off` keeps errors alone, where sleepypod keeps nothing,
 * because a device running a pump must not go silent about a failure, and
 * `debugUntil` opens a window that ends by itself, with no timer and no write.
 * A window further off than the API allows counts as none, or a hand-edited file
 * could stay open for ever. Reads never write, and a damaged file means `quiet`,
 * so warnings survive anything that happens to it.
 *
 * The journal is already in RAM (ADR-0021), so what this saves is CPU and RAM.
 * Node-only: the browser demo reaches it through `Context.logging`, or not at all.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type LoggingMode = 'quiet' | 'off'
export type EffectiveMode = LoggingMode | 'debug'

export interface LoggingState {
  /** What's in force now: `debug` while a window is open. */
  mode: EffectiveMode
  /** What it goes back to. */
  loggingMode: LoggingMode
  debugUntil: string | null
}

export interface LoggingControl {
  get(): LoggingState
  set(patch: { mode?: LoggingMode, debugMinutes?: number }): LoggingState
}

interface PolicyFile {
  loggingMode?: LoggingMode
  /** Epoch milliseconds. */
  debugUntil?: number | null
}

const RELOAD_EVERY_MS = 1000
export const MAX_DEBUG_MINUTES = 240

export function policyPath(env: NodeJS.ProcessEnv, dbPath: string): string {
  return env.SEEDYPOD_RECORDING_POLICY_FILE || join(dirname(dbPath), 'recording-policy.json')
}

function load(path: string): PolicyFile {
  try {
    const p = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return {}
    const { loggingMode = 'quiet', debugUntil = null } = p as PolicyFile
    if (loggingMode !== 'quiet' && loggingMode !== 'off') return {}
    if (debugUntil !== null && (typeof debugUntil !== 'number' || debugUntil < 0)) return {}
    return { loggingMode, debugUntil }
  }
  catch {
    return {}
  }
}

export class RecordingPolicy implements LoggingControl {
  private cached: PolicyFile = {}
  private readAt = -Infinity

  constructor(private readonly o: { path: string, now?: () => number, monotonic?: () => number }) {}

  private policy(): PolicyFile {
    const at = (this.o.monotonic ?? performance.now.bind(performance))()
    if (at - this.readAt >= RELOAD_EVERY_MS) {
      this.cached = load(this.o.path)
      this.readAt = at
    }
    return this.cached
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }

  /** When the open window ends, if one is. */
  private windowEnd(p: PolicyFile): number | null {
    const left = (p.debugUntil ?? 0) - this.now()
    return left > 0 && left <= MAX_DEBUG_MINUTES * 60_000 ? p.debugUntil as number : null
  }

  mode(): EffectiveMode {
    const p = this.policy()
    return this.windowEnd(p) !== null ? 'debug' : p.loggingMode ?? 'quiet'
  }

  get(): LoggingState {
    const p = this.policy()
    const end = this.windowEnd(p)
    return { mode: this.mode(), loggingMode: p.loggingMode ?? 'quiet', debugUntil: end === null ? null : new Date(end).toISOString() }
  }

  /** `debugMinutes: 0` closes a window. Replaces the file in one step, so hald never reads half of it. */
  set(patch: { mode?: LoggingMode, debugMinutes?: number }): LoggingState {
    const p = load(this.o.path)
    const next: PolicyFile = { loggingMode: patch.mode ?? p.loggingMode ?? 'quiet', debugUntil: p.debugUntil ?? null }
    if (patch.debugMinutes !== undefined) next.debugUntil = patch.debugMinutes > 0 ? this.now() + patch.debugMinutes * 60_000 : null
    mkdirSync(dirname(this.o.path), { recursive: true })
    writeFileSync(`${this.o.path}.tmp`, `${JSON.stringify(next)}\n`, { mode: 0o644 })
    renameSync(`${this.o.path}.tmp`, this.o.path)
    this.readAt = -Infinity
    return this.get()
  }
}

type Levels = Pick<Console, 'debug' | 'info' | 'log' | 'warn' | 'error'>

/** Records are dropped here, before console formats them. `error` always gets through, and so does a crash report, which doesn't use console. */
export function installRecordingPolicy(policy: Pick<RecordingPolicy, 'mode'>, target: Levels = console): void {
  for (const level of ['debug', 'info', 'log'] as const) {
    const write = target[level].bind(target)
    target[level] = (...args: unknown[]) => {
      if (policy.mode() === 'debug') write(...args)
    }
  }
  const warn = target.warn.bind(target)
  target.warn = (...args: unknown[]) => {
    if (policy.mode() !== 'off') warn(...args)
  }
}
