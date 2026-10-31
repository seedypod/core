/**
 * Where a backup's files come from on a unit (ADR-0021). Node-only; the
 * paths default to what the installers set up, and the `SEEDYPOD_*`
 * variables move them for the simulated bring-up and tests.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface BackupPaths {
  /** `hal.toml` lives here. */
  etcDir: string
  /** `hald`'s state files (`state.json`, `sensors.json`). */
  stateDir: string
  mosquittoPasswd: string
  capturesDir: string
}

export function backupPaths(env: NodeJS.ProcessEnv, dataDir: string): BackupPaths {
  return {
    etcDir: env.SEEDYPOD_ETC_DIR || '/etc/seedypod',
    stateDir: env.SEEDYPOD_STATE_DIR || '/var/lib/seedypod',
    mosquittoPasswd: env.SEEDYPOD_MOSQUITTO_PASSWD || '/etc/mosquitto/seedypod.passwd',
    capturesDir: join(dataDir, 'captures'),
  }
}

export interface SourceFile {
  /** Path inside the bundle. */
  name: string
  path: string
  /** Missing is normal (no `--mqtt-lan`, no app-added probes); unreadable is not. */
  optional: boolean
}

export interface BackupSources {
  paths: BackupPaths
  /** A consistent copy of the live database. */
  database(): Promise<Uint8Array>
  systemFiles(): SourceFile[]
  read(path: string): Promise<Uint8Array>
  /** Migrations the running core knows, from its journal. */
  schema(): { migrations: number, tag: string | null }
}

export function readSchema(migrationsFolder: string): { migrations: number, tag: string | null } {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }
  return { migrations: journal.entries.length, tag: journal.entries.at(-1)?.tag ?? null }
}

export function nodeBackupSources(o: { paths: BackupPaths, snapshot: (dest: string) => Promise<unknown>, migrationsFolder: string }): BackupSources {
  return {
    paths: o.paths,
    async database() {
      const tmp = join(tmpdir(), `seedypod-backup-${process.pid}-${Date.now()}.db`)
      try {
        await o.snapshot(tmp)
        return new Uint8Array(await readFile(tmp))
      }
      finally {
        await rm(tmp, { force: true })
      }
    },
    systemFiles() {
      const files: SourceFile[] = [
        { name: 'etc/seedypod/hal.toml', path: join(o.paths.etcDir, 'hal.toml'), optional: false },
        { name: 'etc/mosquitto/seedypod.passwd', path: o.paths.mosquittoPasswd, optional: true },
      ]
      if (existsSync(o.paths.stateDir)) {
        try {
          for (const f of readdirSync(o.paths.stateDir).sort()) {
            if (/^[a-z0-9_-]+\.json$/.test(f)) files.push({ name: `var/lib/seedypod/${f}`, path: join(o.paths.stateDir, f), optional: true })
          }
        }
        catch {
          // An unreadable state directory: let the read of its main file report why.
          files.push({ name: 'var/lib/seedypod/state.json', path: join(o.paths.stateDir, 'state.json'), optional: false })
        }
      }
      return files
    },
    read: async path => new Uint8Array(await readFile(path)),
    schema: () => readSchema(o.migrationsFolder),
  }
}
