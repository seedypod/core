/**
 * scripts/install's better-sqlite3 on a Pi Zero W: the release's ARMv6 build, or
 * a compile when that's no good. Run with stub curl, node, pnpm and apt-get, whose
 * pnpm does what the real install script does with the same environment. The
 * real prebuild-install and an ARMv6 load are on the hardware checklist.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../..')
const script = join(repo, 'scripts/install')
const VERSION = '12.11.1'
const ASSET = `better-sqlite3-v${VERSION}-node-v127-linux-armv6.tar.gz`
const BINARY = `node_modules/.pnpm/better-sqlite3@${VERSION}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`

const STUBS: Record<string, string> = {
  'sudo': 'exec "$@"',
  'apt-get': 'echo "apt-get $*" >> "$STATE/log"',
  'curl': `echo "curl $*" >> "$STATE/log"
while [ $# -gt 1 ]; do case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac; done
cp "$STATE/release/\${url##*/}" "$out" 2>/dev/null || exit 22`,
  'node': `case "$*" in
  "-p process.versions.modules") echo 127 ;;
  -v) echo v22.23.4 ;;
  -e\\ *new*) [ -f "$SQLITE_BINARY" ] && ! grep -q crashes "$SQLITE_BINARY" ;;
  -e\\ *require*) ! grep -q crashes "$3" ;;
esac`,
  // better-sqlite3's install script: prebuild-install, then node-gyp. pnpm only runs it on a package it hasn't built.
  'pnpm': `echo "pnpm $* source=\${npm_config_build_from_source:-}" >> "$STATE/log"
[ "$1" != install ] || [ ! -f "$SQLITE_BINARY" ] || exit 0
mkdir -p "$(dirname "$SQLITE_BINARY")"
if [ "\${npm_config_build_from_source:-}" = true ]; then echo compiled > "$SQLITE_BINARY"; exit 0; fi
local="\${npm_config_better_sqlite3_local_prebuilds:-}/better-sqlite3-v${VERSION}-node-v127-linux-arm.tar.gz"
if [ -f "$local" ] && [ ! -f "$STATE/misnamed" ]; then tar xzf "$local"
  mkdir -p "$(dirname "$SQLITE_BINARY")"; mv -f build/Release/better_sqlite3.node "$SQLITE_BINARY"
else echo upstream-armv7 > "$SQLITE_BINARY"; fi`,
}

let dir: string
let prefix: string
let state: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-sqlite-'))
  prefix = join(dir, 'prefix')
  state = join(dir, 'state')
  bin = join(dir, 'bin')
  for (const d of [prefix, join(state, 'release'), bin, join(dir, 'tmp')]) mkdirSync(d, { recursive: true })
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(prefix, 'pnpm-lock.yaml'), `packages:\n\n  better-sqlite3@${VERSION}:\n    resolution: {}\n\nsnapshots:\n\n  better-sqlite3@${VERSION}:\n    dependencies: {}\n`)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Puts an ARMv6 build in the release, with a sha256 of what `hashed` says it is. */
function publish(contents = 'armv6', hashed = contents) {
  const stage = join(dir, 'stage')
  const tar = (body: string, out: string) => {
    mkdirSync(join(stage, 'build/Release'), { recursive: true })
    writeFileSync(join(stage, 'build/Release/better_sqlite3.node'), body)
    spawnSync('tar', ['czf', out, '-C', stage, 'build/Release/better_sqlite3.node'])
  }
  const asset = join(state, 'release', ASSET)
  tar(hashed, asset)
  writeFileSync(`${asset}.sha256`, `${createHash('sha256').update(readFileSync(asset)).digest('hex')}  ${ASSET}\n`)
  if (contents !== hashed) tar(contents, asset)
}

function install(branch = 'dev') {
  const r = spawnSync('bash', ['-c', `source "${script}"; NODE_FROM_SOURCE=1 BRANCH=${branch} TMP="${join(dir, 'tmp')}"; cd "${prefix}"; install_deps`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_LIB_ONLY: '1', STATE: state, SQLITE_BINARY: join(prefix, BINARY) },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const installed = () => readFileSync(join(prefix, BINARY), 'utf8').trim()
const log = () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '')

describe('prebuilt better-sqlite3', () => {
  it('installs the release\'s ARMv6 build without a compiler', () => {
    publish()
    const r = install()
    expect(r).toMatchObject({ code: 0 })
    expect(r.out).toContain('using the prebuilt ARMv6 better-sqlite3')
    expect(installed()).toBe('armv6')
    expect(log()).not.toContain('apt-get')
    expect(log()).toContain(`https://github.com/seedypod/core/releases/download/dev-latest/${ASSET}`)
    expect(log()).toContain('pnpm install --prod --frozen-lockfile source=\n')
  })

  it('takes the asset from the latest release on main', () => {
    publish()
    install('main')
    expect(log()).toContain(`https://github.com/seedypod/core/releases/latest/download/${ASSET}`)
  })

  it('names the asset from the lockfile', () => {
    writeFileSync(join(prefix, 'pnpm-lock.yaml'), readFileSync(join(prefix, 'pnpm-lock.yaml'), 'utf8').replaceAll(VERSION, '13.0.2'))
    install()
    expect(log()).toContain('better-sqlite3-v13.0.2-node-v127-linux-armv6.tar.gz')
  })
})

describe('falling back to a compile', () => {
  const compiled = (r: ReturnType<typeof install>, why: string) => {
    expect(r.code).toBe(0)
    expect(r.err).toContain(why)
    expect(installed()).toBe('compiled')
    expect(log()).toContain('apt-get install -y -q build-essential python3')
  }

  it('compiles when the release has no build for this version', () => {
    compiled(install(), `no prebuilt ${ASSET}`)
  })

  it('compiles when the sha256 is missing', () => {
    publish()
    rmSync(join(state, 'release', `${ASSET}.sha256`))
    compiled(install(), `no prebuilt ${ASSET}`)
  })

  it('compiles when the download fails its sha256', () => {
    publish('tampered', 'armv6')
    compiled(install(), 'fails its sha256')
  })

  it('compiles when the binary doesn\'t load under this Node', () => {
    publish('crashes')
    compiled(install(), 'doesn\'t load under Node v22.23.4')
  })

  it('compiles over upstream\'s ARMv7 binary if prebuild-install missed ours', () => {
    publish()
    writeFileSync(join(state, 'misnamed'), '')
    const r = install()
    expect(r.code).toBe(0)
    expect(r.out).toContain('didn\'t come out usable')
    expect(installed()).toBe('compiled')
    expect(log()).toContain('pnpm rebuild better-sqlite3 source=true')
  })

  it('stops if even the compile doesn\'t load', () => {
    publish('crashes')
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nmkdir -p "$(dirname "$SQLITE_BINARY")"; echo crashes > "$SQLITE_BINARY"\n`)
    const r = install()
    expect(r.code).toBe(1)
    expect(r.err).toContain('still doesn\'t load')
  })
})

describe('a rerun', () => {
  it('keeps the compiled binary, downloading and compiling nothing', () => {
    mkdirSync(join(prefix, BINARY, '..'), { recursive: true })
    writeFileSync(join(prefix, BINARY), 'compiled earlier\n')
    publish()
    const r = install()
    expect(r.code).toBe(0)
    expect(installed()).toBe('compiled earlier')
    expect(log()).not.toContain('curl')
    expect(log()).not.toContain('apt-get')
    expect(log()).not.toContain('rebuild')
  })

  it('recompiles one that no longer loads', () => {
    mkdirSync(join(prefix, BINARY, '..'), { recursive: true })
    writeFileSync(join(prefix, BINARY), 'crashes\n')
    const r = install()
    expect(r.code).toBe(0)
    expect(installed()).toBe('compiled')
    expect(log()).toContain('pnpm rebuild better-sqlite3 source=true')
  })

  it('fetches the new version after a lockfile bump', () => {
    const old = BINARY.replace(VERSION, '12.10.0')
    mkdirSync(join(prefix, old, '..'), { recursive: true })
    writeFileSync(join(prefix, old), 'compiled earlier\n')
    publish()
    expect(install().code).toBe(0)
    expect(installed()).toBe('armv6')
  })
})

describe('scripts/build-sqlite-armv6', () => {
  it('reads both versions from the repo, so the asset can\'t drift from the install', () => {
    const r = spawnSync('bash', [join(repo, 'scripts/build-sqlite-armv6'), '--versions'], { encoding: 'utf8' })
    const lock = readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8').match(/^ {2}better-sqlite3@([\d.]+):$/m)?.[1]
    const node = readFileSync(script, 'utf8').match(/^NODE_22=(.+)$/m)?.[1]
    expect(r.stdout).toBe(`sqlite=${lock}\nnode=${node}\n`)
  })
})
