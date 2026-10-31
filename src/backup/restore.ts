/**
 * Core's side of a restore (ADR-0021 phase 3): hand a bundle to the root
 * helper (`scripts/seedypod-restore.cjs`, installed as
 * /usr/local/sbin/seedypod-restore) and read back what it did. The helper
 * checks the bundle before it returns, so a refusal (a newer schema, a damaged
 * file) comes back here; the restore itself then runs in its own unit and
 * restarts core. Node-only.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const INSTALLED_HELPER = '/usr/local/sbin/seedypod-restore'

export interface BundleSummary {
  createdAt: string | null
  unit: { id: string | null, name: string } | null
  core: string | null
  schema: number | null
  photos: boolean
}

export interface RestoreStatus {
  op: 'restore' | 'undo' | 'check'
  state: 'checking' | 'queued' | 'stopping' | 'restoring' | 'starting' | 'done' | 'failed' | 'refused'
  at: string
  error?: string
  code?: string
  bundle?: BundleSummary
  undone?: boolean
}

export interface UndoInfo {
  restoredAt: string
  bundle: BundleSummary
  undoneAt: string | null
}

export class RestoreRefused extends Error {
  constructor(readonly code: 'newer-schema' | 'invalid' | 'failed' | 'unavailable', message: string) {
    super(message)
  }
}

/** `SEEDYPOD_RESTORE_CMD` (a JSON array) overrides; otherwise sudo and the installed helper, when it's there. */
export function restoreCommand(env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (env.SEEDYPOD_RESTORE_CMD) return JSON.parse(env.SEEDYPOD_RESTORE_CMD) as string[]
  return existsSync(INSTALLED_HELPER) ? ['sudo', '-n', INSTALLED_HELPER] : null
}

export interface RestoreClientOptions {
  /** Null where the helper isn't installed: restore then says so instead of failing. */
  command: string[] | null
  /** Where the helper keeps `status.json` and `undo.json`. */
  workDir: string
  /** Uploads and bucket downloads are written here for the helper, on the data partition (not a small /tmp). */
  uploadDir: string
}

export class RestoreClient {
  constructor(private readonly o: RestoreClientOptions) {}

  get available(): boolean {
    return !!this.o.command
  }

  private exec(args: string[]): Promise<{ code: number, result: { ok: boolean, code?: string, error?: string, bundle?: BundleSummary } }> {
    const cmd = this.o.command
    if (!cmd) return Promise.reject(new RestoreRefused('unavailable', 'restore isn\'t installed on this core: run scripts/install on the unit'))
    return new Promise((resolve) => {
      execFile(cmd[0] as string, [...cmd.slice(1), ...args], { timeout: 10 * 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        const last = stdout.trim().split('\n').at(-1) ?? ''
        try {
          resolve({ code, result: JSON.parse(last) })
        }
        catch {
          resolve({ code, result: { ok: false, code: 'failed', error: (stderr || err?.message || 'the restore helper gave no answer').trim() } })
        }
      })
    })
  }

  private async outcome(args: string[]): Promise<BundleSummary | null> {
    const { result } = await this.exec(args)
    if (result.ok) return result.bundle ?? null
    const code = result.code === 'newer-schema' || result.code === 'invalid' ? result.code : 'failed'
    throw new RestoreRefused(code, result.error ?? 'restore failed')
  }

  /** Checks the bundle, then restores it in the background; core restarts. Throws `RestoreRefused` on a bad bundle. */
  async restore(bytes: Uint8Array | ((path: string) => Promise<void>)): Promise<BundleSummary | null> {
    const path = join(this.o.uploadDir, `restore-upload-${Date.now()}.tar.gz`)
    try {
      if (typeof bytes === 'function') await bytes(path)
      else await writeFile(path, bytes)
      return await this.outcome(['--detach', path])
    }
    finally {
      // The helper copies what it needs into its own staging directory before it returns.
      await rm(path, { force: true })
    }
  }

  /** Puts back what the last restore replaced (a second undo redoes it). Core restarts. */
  async undo(): Promise<void> {
    await this.outcome(['--undo', '--detach'])
  }

  private read<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.o.workDir, file), 'utf8')) as T
    }
    catch {
      return null
    }
  }

  info(): { available: boolean, status: RestoreStatus | null, undo: UndoInfo | null } {
    const undo = this.read<UndoInfo & { items?: unknown }>('undo.json')
    if (undo) delete undo.items
    return { available: this.available, status: this.read<RestoreStatus>('status.json'), undo }
  }
}
