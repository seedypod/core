/**
 * Core's side of an update (ADR-0026): the one place core runs the root
 * update helper (`scripts/seedypod-update.cjs`, installed as
 * /usr/local/sbin/seedypod-update), always through sudo with the fixed
 * arguments its sudoers rule lists. Core itself never reaches the internet;
 * the helper does, when someone asks. While an update runs, the helper's
 * status file and log become `update` events on the bus, so Settings follows
 * along over SSE. Node-only.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { EventBus } from '../lib/eventBus'
import { isRunning, UPDATE_STATES, type UpdateChannel, type UpdateState } from './types'

export { isRunning, UPDATE_STATES, type UpdateChannel, type UpdateState } from './types'

export const INSTALLED_UPDATER = '/usr/local/sbin/seedypod-update'

export interface UpdateStatus {
  op?: string
  state: UpdateState
  at: string
  channel?: UpdateChannel
  from?: { version: string | null, commit: string | null, tag?: string | null }
  to?: { tag: string, commit: string, version?: string | null }
  error?: string
  code?: string
  rolledBack?: boolean
}

export interface UpdateCheck {
  channel: UpdateChannel
  installed: { version: string | null, commit: string | null, branch: string | null, tag: string | null }
  available: { tag: string, commit: string, name: string, publishedAt: string | null, url: string | null }
  updateAvailable: boolean
  problem: string | null
}

/** What `check.json` keeps of the helper's last check. */
export interface LastCheck {
  at: string
  channel: UpdateChannel
  available: { tag: string, commit: string, name: string }
  problem: string | null
}

export interface UpdateInfo {
  available: boolean
  channel: UpdateChannel
  /** The release tag of the build core runs, when an update installed it. */
  tag: string | null
  status: UpdateStatus | null
  /** The last lines of the helper's log for the current or last run. */
  log: string[]
}

export class UpdateRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** `SEEDYPOD_UPDATE_CMD` (a JSON array) overrides; otherwise sudo and the installed helper, when it's there. */
export function updateCommand(env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (env.SEEDYPOD_UPDATE_CMD) return JSON.parse(env.SEEDYPOD_UPDATE_CMD) as string[]
  return existsSync(INSTALLED_UPDATER) ? ['sudo', '-n', INSTALLED_UPDATER] : null
}

export interface UpdateClientOptions {
  /** Null where the helper isn't installed: Settings then says so. */
  command: string[] | null
  /** The helper's state directory: `status.json`, `update.log`, `channel`, `installed.json`. */
  workDir: string
  /** Core's own version (`branch@commit`), for the channel when none was chosen. */
  version: string
  events?: EventBus
  /** How often to look at the status file while an update runs. */
  pollMs?: number
}

const LOG_LINES = 200

export class UpdateClient {
  private timer: ReturnType<typeof setInterval> | null = null
  private seen = { at: '', bytes: 0 }

  constructor(private readonly o: UpdateClientOptions) {
    // A core that starts mid-update (the new version, under its health check) follows it to the end.
    if (isRunning(this.status()?.state)) this.watch()
  }

  get available(): boolean {
    return !!this.o.command
  }

  private exec(args: string[]): Promise<Record<string, unknown> & { ok: boolean, code?: string, error?: string }> {
    const cmd = this.o.command
    if (!cmd) return Promise.reject(new UpdateRefused('unavailable', 'the update helper isn\'t installed on this core: run scripts/install on the unit'))
    return new Promise((resolve, reject) => {
      execFile(cmd[0] as string, [...cmd.slice(1), ...args], { timeout: 3 * 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const last = stdout.trim().split('\n').at(-1) ?? ''
        let result: Record<string, unknown> & { ok: boolean, code?: string, error?: string }
        try {
          result = JSON.parse(last)
        }
        catch {
          return reject(new UpdateRefused('failed', (stderr || err?.message || 'the update helper gave no answer').trim()))
        }
        if (!result.ok) return reject(new UpdateRefused(result.code ?? 'failed', result.error ?? 'the update helper failed'))
        resolve(result)
      })
    })
  }

  private read(file: string): string | null {
    try {
      return readFileSync(join(this.o.workDir, file), 'utf8')
    }
    catch {
      return null
    }
  }

  private json<T>(file: string): T | null {
    const text = this.read(file)
    if (text === null) return null
    try {
      return JSON.parse(text) as T
    }
    catch {
      return null
    }
  }

  status(): UpdateStatus | null {
    const s = this.json<UpdateStatus>('status.json')
    return s && (UPDATE_STATES as readonly string[]).includes(s.state) ? s : null
  }

  /**
   * The helper's last check on this channel, or null if there's been none. Whether
   * it's newer is worked out against the build core runs, so an update since
   * doesn't leave it saying there's one to install.
   */
  lastCheck(): (LastCheck & { updateAvailable: boolean }) | null {
    const c = this.json<LastCheck>('check.json')
    if (!c || c.channel !== this.channel() || typeof c.available?.commit !== 'string' || Number.isNaN(Date.parse(c.at))) return null
    const commit = this.o.version.split('@')[1]
    return { ...c, updateAvailable: !commit || !c.available.commit.startsWith(commit) }
  }

  channel(): UpdateChannel {
    const c = this.read('channel')?.trim()
    if (c === 'stable' || c === 'dev') return c
    return this.o.version.startsWith('main@') ? 'stable' : 'dev'
  }

  private log(): string[] {
    return (this.read('update.log') ?? '').split('\n').filter(Boolean).slice(-LOG_LINES)
  }

  info(): UpdateInfo {
    const installed = this.json<{ tag?: string, version?: string }>('installed.json')
    return {
      available: this.available,
      channel: this.channel(),
      tag: installed?.version === this.o.version ? installed.tag ?? null : null,
      status: this.status(),
      log: this.log(),
    }
  }

  /** Asks GitHub, through the helper, what the channel has. The only time a check goes online. */
  async check(): Promise<UpdateCheck> {
    const r = await this.exec(['--check'])
    return { channel: r.channel, installed: r.installed, available: r.available, updateAvailable: r.updateAvailable, problem: r.problem ?? null } as UpdateCheck
  }

  async setChannel(channel: UpdateChannel): Promise<UpdateChannel> {
    // Belt and braces: sudoers only allows these two, and the helper checks again.
    if (channel !== 'stable' && channel !== 'dev') throw new UpdateRefused('usage', 'the channel must be stable or dev')
    await this.exec(['--channel', channel])
    return channel
  }

  /** Checks, then starts the update in the helper's own unit; core restarts on the new version. */
  async start(): Promise<UpdateStatus | null> {
    await this.exec(['--start'])
    this.watch()
    return this.status()
  }

  /** Emits what changed in the status file and log since the last look; stops once the update is over. */
  tick(): void {
    const s = this.status()
    let bytes = 0
    try {
      bytes = statSync(join(this.o.workDir, 'update.log')).size
    }
    catch {
      // no log yet
    }
    if (s && (s.at !== this.seen.at || bytes !== this.seen.bytes)) {
      const text = this.read('update.log') ?? ''
      const fresh = bytes < this.seen.bytes ? text : text.slice(this.seen.bytes)
      this.seen = { at: s.at, bytes }
      this.o.events?.emit({ kind: 'update', state: s.state, lines: fresh.split('\n').filter(Boolean) })
    }
    if (!isRunning(s?.state)) this.stop()
  }

  private watch(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.o.pollMs ?? 1000)
    this.timer.unref?.()
  }

  get watching(): boolean {
    return !!this.timer
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
