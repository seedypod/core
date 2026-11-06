/**
 * What scripts/install does differently on a unit flashed with the OS image, where
 * core has an account of its own, and what the image build hands it. Run with stub
 * sudo and systemctl; scripts/image/verify checks the real thing on every build.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install')
const STUBS: Record<string, string> = {
  sudo: 'echo "sudo $*" >> "$STATE/log"',
  hald: 'echo \'{ "unit_id": "gardyn-db753a85" }\'',
}

let dir: string
let root: string
let state: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-image-'))
  root = join(dir, 'root')
  state = join(dir, 'state')
  bin = join(dir, 'bin')
  mkdirSync(join(root, 'etc/systemd/system'), { recursive: true })
  for (const d of [state, bin]) mkdirSync(d)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(state, 'log'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(commands: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `source "${script}"; ${commands}`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: root, STATE: state, USER: 'alice', ...env },
  })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr }
}

const unit = (name: string, body: string) => writeFileSync(join(root, 'etc/systemd/system', name), body)
const log = () => readFileSync(join(state, 'log'), 'utf8')

describe('the account core runs as', () => {
  it('is the login that installs it, on a card it was installed on by hand', () => {
    expect(run('core_user').out).toBe('alice')
  })

  it('stays whatever core already runs as, so an update from the login keeps seedypod-core', () => {
    unit('seedypod-core.service', '[Service]\nUser=seedypod-core\n')
    expect(run('core_user').out).toBe('seedypod-core')
  })

  it('is what the image build asks for', () => {
    expect(run('core_user', { SEEDYPOD_CORE_USER: 'seedypod-core' }).out).toBe('seedypod-core')
  })
})

describe('the group that reads hald\'s files', () => {
  it('is seedypod where install-hal hasn\'t said otherwise', () => {
    expect(run('hal_group').out).toBe('seedypod')
  })

  it('follows hald\'s account, which is seedypod-hal on the image', () => {
    unit('hald.service', '[Service]\nUser=seedypod-hal\nGroup=seedypod-hal\n')
    expect(run('hal_group').out).toBe('seedypod-hal')
  })
})

describe('unpacking over a prefix core owns', () => {
  const claim = (coreUser: string) => run(`PREFIX=/opt/seedypod CORE_USER=${coreUser}; claim_prefix; echo "store=\${npm_config_store_dir:-}"; finish_prefix`)

  it('is the plain chown it always was when the login is core\'s account', () => {
    const r = claim('alice')
    expect(r.out).toBe('store=')
    expect(log()).toContain('sudo chown alice /opt/seedypod')
    expect(log()).not.toContain('chown -R')
    expect(log()).not.toContain('systemctl stop')
  })

  it('stops core, borrows the prefix and hands all of it back', () => {
    claim('seedypod-core')
    expect(log().split('\n').filter(Boolean)).toEqual([
      'sudo mkdir -p /opt/seedypod',
      'sudo systemctl stop seedypod-core.service',
      'sudo chown -R alice /opt/seedypod',
      'sudo chown -R seedypod-core /opt/seedypod',
    ])
  })

  it('keeps pnpm on the store node_modules came from, or it would rebuild better-sqlite3', () => {
    expect(claim('seedypod-core').out).toBe('store=/opt/seedypod/.pnpm-store')
  })
})

describe('install-hal on a machine with no hald yet', () => {
  it('gets past choosing hald\'s account, which reads a unit that isn\'t there', () => {
    const r = spawnSync('bash', [resolve(script, '../install-hal'), '--help'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('seedypod HAL (hald) installer')
  })
})

describe('the unit id', () => {
  it('comes from hald, for first boot as much as for an install', () => {
    expect(run('hal_unit_id').out).toBe('gardyn-db753a85')
  })
})

describe('a build with no network for its own assets', () => {
  it('reads better-sqlite3 from SEEDYPOD_RELEASE_URL', () => {
    const stub = `echo "curl $*" >> "$STATE/log"; exit 22`
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\n${stub}\n`)
    chmodSync(join(bin, 'curl'), 0o755)
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho 127\n')
    chmodSync(join(bin, 'node'), 0o755)
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages:\n\n  better-sqlite3@12.11.1:\n    resolution: {}\n')
    run(`BRANCH=dev TMP="${dir}"; cd "${dir}"; fetch_sqlite_prebuilt || true`, { SEEDYPOD_RELEASE_URL: 'file:///tmp/assets' })
    expect(log()).toContain('file:///tmp/assets/better-sqlite3-v12.11.1-node-v127-linux-armv6.tar.gz')
    expect(log()).not.toContain('github.com')
  })
})
