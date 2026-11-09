/**
 * scripts/install's update helper (ADR-0026), against a scratch root with stub
 * sudo and visudo: the helper lands with the prefix written in, and sudoers
 * names every command core may run, with nothing open-ended.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000 })

const script = resolve(import.meta.dirname, '../../scripts/install')
const helper = resolve(import.meta.dirname, '../../scripts/seedypod-update.cjs')

let dir: string
let root: string
let prefix: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-update-'))
  root = join(dir, 'root')
  prefix = join(dir, 'opt/seedypod')
  bin = join(dir, 'bin')
  for (const d of [root, join(prefix, 'scripts'), bin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(prefix, 'scripts/seedypod-update.cjs'), readFileSync(helper))
  const stubs: Record<string, string> = {
    // Ownership needs root; everything else runs as it would.
    sudo: 'case "$1" in chown) exit 0 ;; install) shift; while [ "${1#-}" != "$1" ]; do case "$1" in -m|-o|-g) shift 2 ;; *) shift ;; esac; done; exec cp "$@" ;; esac\nexec "$@"',
    visudo: 'echo "visudo $*" >> "$STATE/log"; [ ! -f "$STATE/bad-sudoers" ]',
  }
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function install() {
  const r = spawnSync('bash', ['-c', `source "${script}"; CORE_USER=seedypod-core; install_update_helper`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_ROOT: root, SEEDYPOD_PREFIX: prefix, SEEDYPOD_LIB_ONLY: '1', STATE: dir },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('the update helper', () => {
  it('lands root-owned in /usr/local/sbin with this prefix written in', () => {
    expect(install()).toMatchObject({ code: 0 })
    const installed = readFileSync(join(root, 'usr/local/sbin/seedypod-update'), 'utf8')
    expect(installed).toContain(`const INSTALLED_PREFIX = '${prefix}'`)
    expect(installed).not.toContain('__PREFIX__')
    // Its own copy of the next release still gets the prefix written in.
    expect(installed).toContain('.replace([\'__PRE\', \'FIX__\'].join(\'\'), P.prefix)')
  })

  it('lets core run it with each fixed command and nothing else', () => {
    expect(install()).toMatchObject({ code: 0 })
    const rules = readFileSync(join(root, 'etc/sudoers.d/seedypod-update'), 'utf8').trim().split('\n')
    expect(rules).toEqual([
      'seedypod-core ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --status',
      'seedypod-core ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --check',
      'seedypod-core ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --start',
      'seedypod-core ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --channel stable',
      'seedypod-core ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --channel dev',
    ])
    // A rule with no arguments, or a wildcard, would let core pass anything.
    for (const r of rules) expect(r).toMatch(/seedypod-update --[a-z]+( (stable|dev))?$/)
    expect(readFileSync(join(dir, 'log'), 'utf8')).toMatch(/^visudo -cf /)
  })

  it('writes no rule visudo rejects', () => {
    writeFileSync(join(dir, 'bad-sudoers'), '')
    expect(install().code).not.toBe(0)
    expect(existsSync(join(root, 'etc/sudoers.d/seedypod-update'))).toBe(false)
  })
})
