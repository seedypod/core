/**
 * Node-only storage for the model registry (#186): uploaded weights files as
 * `<sha256>.json` and the registry's state as `registry.json`, in a folder
 * under DATA_DIR. That is outside the release folder, so an update (ADR-0026)
 * keeps them. Writes go to a temporary file and are renamed into place.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPodStateModel } from './modelFile'
import type { ModelFiles, RegistryState } from './registry'

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const SHA_FILE = /^([0-9a-f]{64})\.json$/

export class FsModelFiles implements ModelFiles {
  constructor(private readonly dir: string, private readonly readShipped = () => readPodStateModel()) {}

  shipped() {
    return this.readShipped()
  }

  list(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).map(f => SHA_FILE.exec(f)?.[1]).filter((s): s is string => !!s)
  }

  read(sha: string): string | null {
    const path = this.path(sha)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  path(sha: string): string {
    return join(this.dir, `${sha}.json`)
  }

  write(sha: string, text: string): void {
    this.atomic(this.path(sha), text)
  }

  remove(sha: string): void {
    rmSync(this.path(sha), { force: true })
  }

  readState(): RegistryState | null {
    const path = join(this.dir, 'registry.json')
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RegistryState
    }
    catch {
      // A torn write can't happen (rename), but a hand edit can: start from the shipped default.
      return null
    }
  }

  writeState(state: RegistryState): void {
    this.atomic(join(this.dir, 'registry.json'), `${JSON.stringify(state, null, 2)}\n`)
  }

  private atomic(path: string, text: string): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(`${path}.tmp`, text)
    renameSync(`${path}.tmp`, path)
  }
}
