/**
 * scripts/install's Node choice: 24 (.node-version) on 64-bit ARM and x86,
 * 22 on 32-bit ARM, with uname, getconf and the device-tree model faked.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-board-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function check(o: { model?: string, arch: string, bits: number }) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho ${o.arch}\n`)
  writeFileSync(join(bin, 'getconf'), `#!/bin/sh\necho ${o.bits}\n`)
  chmodSync(join(bin, 'uname'), 0o755)
  chmodSync(join(bin, 'getconf'), 0o755)
  rmSync(join(dir, 'proc'), { recursive: true, force: true })
  if (o.model) {
    mkdirSync(join(dir, 'proc/device-tree'), { recursive: true })
    // The kernel's model string ends in a NUL.
    writeFileSync(join(dir, 'proc/device-tree/model'), `${o.model}\0`)
  }
  const r = spawnSync('bash', [script, '--check'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_ROOT: dir }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

describe('scripts/install --check', () => {
  it('runs core on Node from .node-version where it ships: 64-bit ARM and x86', () => {
    expect(check({ model: 'Raspberry Pi Zero 2 W Rev 1.0', arch: 'aarch64', bits: 64 })).toEqual({ code: 0, out: '✓ Raspberry Pi Zero 2 W Rev 1.0 runs core on Node from .node-version', err: '' })
    expect(check({ arch: 'x86_64', bits: 64 })).toMatchObject({ code: 0, out: '✓ x86_64 runs core on Node from .node-version' })
  })

  it('falls back to Node 22 on a 32-bit OS, and says reflashing gets back to 24', () => {
    for (const arch of ['armv7l', 'aarch64']) {
      const r = check({ model: 'Raspberry Pi Zero 2 W Rev 1.0', arch, bits: 32 })
      expect(r.code).toBe(0)
      expect(r.out).toContain('runs core on Node 22.23.4 (armv7l): Node 24 has no 32-bit ARM build.')
      expect(r.out).toContain('Reflash with 64-bit Raspberry Pi OS Lite to move to Node 24.')
    }
  })

  it('runs the original Pi Zero W on the ARMv6 build of Node 22, compiling SQLite there', () => {
    const r = check({ model: 'Raspberry Pi Zero W Rev 1.1', arch: 'armv6l', bits: 32 })
    expect(r.code).toBe(0)
    expect(r.out).toContain('runs core on Node 22.23.4 (armv6l)')
    expect(r.out).toContain('A Pi Zero 2 W on 64-bit Raspberry Pi OS moves to Node 24.')
    expect(r.out).toContain('better-sqlite3 has no ARMv6 build, so it compiles here')
  })

  it('turns away a CPU Node has no build for', () => {
    expect(check({ arch: 'mips', bits: 32 })).toMatchObject({ code: 3, err: '✗ This mips machine can\'t run core: Node has no build for it.' })
  })
})
