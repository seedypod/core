/**
 * scripts/install's podvision (#191): the release's binary for this CPU,
 * checked against its sha256 and run once before it goes in. Stub curl,
 * uname and getconf stand in for the release and the Pi.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install')

const STUBS: Record<string, string> = {
  sudo: 'exec "$@"',
  uname: '[ "$1" = -m ] && cat "$STATE/machine"',
  getconf: 'cat "$STATE/bits"',
  curl: `echo "curl $*" >> "$STATE/log"
while [ $# -gt 1 ]; do case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac; done
cp "$STATE/release/\${url##*/}" "$out" 2>/dev/null || exit 22`,
}

let dir: string
let state: string
let root: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-podvision-'))
  state = join(dir, 'state')
  root = join(dir, 'root')
  bin = join(dir, 'bin')
  for (const d of [join(state, 'release'), root, bin, join(dir, 'tmp')]) mkdirSync(d, { recursive: true })
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  machine('armv6l', 32)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function machine(arch: string, bits: number) {
  writeFileSync(join(state, 'machine'), `${arch}\n`)
  writeFileSync(join(state, 'bits'), `${bits}\n`)
}

/** A podvision in the release that prints `version`, with a sha256 of what `hashed` is. */
function publish(target: string, version = 'podvision 0.1.0', opts: { hashed?: string, runs?: boolean } = {}) {
  const body = (v: string) => `#!/bin/sh\n${opts.runs === false ? 'exit 126' : `echo "${v}"`}\n`
  const asset = join(state, 'release', `podvision-${target}`)
  writeFileSync(asset, body(opts.hashed ?? version))
  writeFileSync(`${asset}.sha256`, `${createHash('sha256').update(readFileSync(asset)).digest('hex')}  podvision-${target}\n`)
  writeFileSync(asset, body(version))
}

function install(branch = 'dev') {
  const r = spawnSync('bash', ['-c', `source "${script}"; BRANCH=${branch} TMP="${join(dir, 'tmp')}"; install_podvision`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: root, STATE: state, SEEDYPOD_COLOR: 'never' },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const dest = () => join(root, 'usr/local/bin/podvision')
const log = () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '')

describe('podvision from the release', () => {
  it('installs the ARMv6 build on a Pi Zero W, from dev-latest on the dev branch', () => {
    publish('arm-unknown-linux-gnueabihf')
    const r = install()
    expect(r).toMatchObject({ code: 0 })
    expect(r.out).toContain('installed podvision 0.1.0 for pod-state')
    expect(readFileSync(dest(), 'utf8')).toContain('podvision 0.1.0')
    expect(log()).toContain('https://github.com/seedypod/core/releases/download/dev-latest/podvision-arm-unknown-linux-gnueabihf')
  })

  it('installs the aarch64 build on a 64-bit Pi, from the latest release on main', () => {
    machine('aarch64', 64)
    publish('aarch64-unknown-linux-gnu')
    expect(install('main').code).toBe(0)
    expect(existsSync(dest())).toBe(true)
    expect(log()).toContain('https://github.com/seedypod/core/releases/latest/download/podvision-aarch64-unknown-linux-gnu')
  })

  it('takes the 32-bit build for a 64-bit CPU on a 32-bit OS', () => {
    machine('aarch64', 32)
    publish('arm-unknown-linux-gnueabihf')
    expect(install().code).toBe(0)
    expect(existsSync(dest())).toBe(true)
  })

  it('leaves a matching binary alone on a rerun, and replaces one that changed', () => {
    publish('arm-unknown-linux-gnueabihf')
    install()
    expect(install().out).not.toContain('installed')
    publish('arm-unknown-linux-gnueabihf', 'podvision 0.2.0')
    expect(install().out).toContain('installed podvision 0.2.0')
  })

  it('refuses a binary that fails its sha256, is missing, or doesn\'t run', () => {
    publish('arm-unknown-linux-gnueabihf', 'podvision 0.1.0', { hashed: 'something else' })
    expect(install()).toMatchObject({ code: 1, err: expect.stringContaining('fails its sha256') })
    publish('arm-unknown-linux-gnueabihf', 'podvision 0.1.0', { runs: false })
    expect(install()).toMatchObject({ code: 1, err: expect.stringContaining('doesn\'t run on this machine') })
    rmSync(join(state, 'release'), { recursive: true })
    expect(install()).toMatchObject({ code: 1, err: expect.stringContaining('no podvision-arm-unknown-linux-gnueabihf in this release') })
    expect(existsSync(dest())).toBe(false)
  })

  it('skips a machine it has no build for, without failing the install', () => {
    machine('x86_64', 64)
    const r = install()
    expect(r).toMatchObject({ code: 0 })
    expect(r.out).toContain('pod-state runs in TypeScript')
    expect(log()).toBe('')
  })
})
