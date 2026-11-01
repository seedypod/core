/**
 * scripts/install's board check: which machines can run core (Node ships for
 * 64-bit ARM and x86 only), with uname, getconf and the device-tree model faked.
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
  it('passes a Pi Zero 2 W on 64-bit Raspberry Pi OS, and a 64-bit LAN box', () => {
    expect(check({ model: 'Raspberry Pi Zero 2 W Rev 1.0', arch: 'aarch64', bits: 64 })).toEqual({ code: 0, out: '✓ Raspberry Pi Zero 2 W Rev 1.0 can run core', err: '' })
    expect(check({ arch: 'x86_64', bits: 64 })).toMatchObject({ code: 0, out: '✓ x86_64 can run core' })
  })

  it('asks a 64-bit-capable Pi on a 32-bit OS to reflash', () => {
    for (const arch of ['armv7l', 'aarch64']) {
      const r = check({ model: 'Raspberry Pi Zero 2 W Rev 1.0', arch, bits: 32 })
      expect(r.code).toBe(3)
      expect(r.err).toContain('is running a 32-bit OS')
      expect(r.err).toContain('Raspberry Pi OS Lite (64-bit)')
    }
  })

  it('turns the original Pi Zero W away, with the two ways forward', () => {
    const r = check({ model: 'Raspberry Pi Zero W Rev 1.1', arch: 'armv6l', bits: 32 })
    expect(r.code).toBe(3)
    expect(r.err).toContain('This Raspberry Pi Zero W Rev 1.1 can\'t run core')
    expect(r.err).toContain('swap in a Pi Zero 2 W')
    expect(r.err).toContain('run scripts/install-hal here and core on another machine')
  })
})
