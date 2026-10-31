import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobSink } from './captures'

/** Filesystem sink for the unit; `dir` defaults to ./data/captures. */
export class FsSink implements BlobSink {
  constructor(private readonly dir: string) {}
  async put(key: string, bytes: Uint8Array) {
    await mkdir(this.dir, { recursive: true })
    const p = join(this.dir, key)
    await writeFile(p, bytes)
    return p
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(key))
    }
    catch {
      return null
    }
  }

  async remove(key: string) {
    await rm(key, { force: true })
  }
}
