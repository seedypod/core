/**
 * scripts/install's cleanup of server/dist: tar never deletes, and each build
 * names its chunks anew, so what the tarball doesn't carry has to go.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install')
let dir: string
let prefix: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-dist-'))
  prefix = join(dir, 'prefix')
  mkdirSync(join(prefix, 'server/dist'), { recursive: true })
  for (const f of ['index.js', 'chunk-NEW.js']) writeFileSync(join(prefix, 'server/dist', f), f)
  spawnSync('tar', ['czf', join(dir, 'pkg'), '-C', prefix, '.'])
  writeFileSync(join(prefix, 'server/dist/chunk-OLD.js'), 'old')
  writeFileSync(join(prefix, 'server/dist/chunk-OLD.js.map'), 'old')
  writeFileSync(join(prefix, 'keep.txt'), 'not ours to touch')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function prune(tarball: string) {
  return spawnSync('bash', ['-c', `set -euo pipefail; source "${script}"; cd "${prefix}"; prune_dist "${tarball}"`], {
    encoding: 'utf8',
    env: { ...process.env, SEEDYPOD_LIB_ONLY: '1' },
  })
}
const has = (p: string) => existsSync(join(prefix, p))

describe('prune_dist', () => {
  it('removes chunks the tarball doesn\'t carry and keeps the ones it does', () => {
    expect(prune(join(dir, 'pkg')).status).toBe(0)
    expect(has('server/dist/chunk-OLD.js')).toBe(false)
    expect(has('server/dist/chunk-OLD.js.map')).toBe(false)
    expect(has('server/dist/index.js')).toBe(true)
    expect(has('server/dist/chunk-NEW.js')).toBe(true)
    expect(has('keep.txt')).toBe(true)
  })

  it('removes nothing when the tarball can\'t be read', () => {
    expect(prune(join(dir, 'missing')).status).toBe(0)
    expect(has('server/dist/chunk-OLD.js')).toBe(true)
    expect(has('server/dist/index.js')).toBe(true)
  })

  it('removes nothing when the tarball has no server build', () => {
    spawnSync('tar', ['czf', join(dir, 'empty'), '-C', prefix, 'keep.txt'])
    expect(prune(join(dir, 'empty')).status).toBe(0)
    expect(has('server/dist/index.js')).toBe(true)
  })
})
