/**
 * What lets a rerun of install-hal skip work: finding a broker that isn't on
 * this user's PATH, and only reporting a unit as changed when it is.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install-hal')

let dir: string
let root: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-hal-rerun-'))
  root = join(dir, 'root')
  bin = join(dir, 'bin')
  for (const d of [bin, join(root, 'usr/sbin')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(bin, 'id'), '#!/bin/sh\n[ "$1" = -nG ] && [ "$2" = seedypod ] && echo "seedypod gpio video"\n')
  chmodSync(join(bin, 'id'), 0o755)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(fn: string, input?: string) {
  const r = spawnSync('bash', ['-c', `source "${script}"; SUDO=; ${fn}`], {
    encoding: 'utf8',
    input,
    env: { PATH: `${bin}:/usr/bin:/bin`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: root },
  })
  return { code: r.status, out: r.stdout }
}

describe('have_broker', () => {
  const exec = (path: string) => {
    writeFileSync(path, '')
    chmodSync(path, 0o755)
  }

  it('finds mosquitto in /usr/sbin, off this user\'s PATH', () => {
    exec(join(root, 'usr/sbin/mosquitto'))
    exec(join(bin, 'mosquitto_sub'))
    expect(run('have_broker').code).toBe(0)
  })

  it('finds one on the PATH', () => {
    exec(join(bin, 'mosquitto'))
    exec(join(bin, 'mosquitto_sub'))
    expect(run('have_broker').code).toBe(0)
  })

  it('says so when there is none', () => {
    expect(run('have_broker').code).toBe(1)
  })

  it('sends a broker without its clients to apt', () => {
    exec(join(root, 'usr/sbin/mosquitto'))
    expect(run('have_broker').code).toBe(1)
  })
})

describe('in_group', () => {
  it('matches whole group names', () => {
    expect(run('in_group seedypod gpio').code).toBe(0)
    expect(run('in_group seedypod gp').code).toBe(1)
    expect(run('in_group seedypod i2c').code).toBe(1)
  })
})

describe('put_unit', () => {
  const unit = () => join(root, 'hald.service')
  const put = (text: string) => run(`UNIT_CHANGED=0; put_unit "${unit()}"; echo "changed=$UNIT_CHANGED"`, text)

  it('writes a new unit and says it changed', () => {
    expect(put('[Unit]\nDescription=x\n').out).toContain('changed=1')
    expect(readFileSync(unit(), 'utf8')).toBe('[Unit]\nDescription=x\n')
  })

  it('says nothing changed for the same text', () => {
    put('[Unit]\n')
    expect(put('[Unit]\n').out).toContain('changed=0')
  })

  it('rewrites a unit that differs', () => {
    put('[Unit]\n')
    expect(put('[Service]\n').out).toContain('changed=1')
    expect(readFileSync(unit(), 'utf8')).toBe('[Service]\n')
  })

  it('stops the install when the write fails, rather than reading as unchanged', () => {
    writeFileSync(join(bin, 'tee'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(bin, 'tee'), 0o755)
    const r = put('[Unit]\n')
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('changed=')
  })
})

describe('a restart owed', () => {
  const hald = () => join(root, 'var/lib/seedypod/.restart-hald')
  const core = () => join(root, 'var/lib/seedypod/.restart-core')
  const log = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '')

  beforeEach(() => {
    mkdirSync(join(root, 'var/lib/seedypod'), { recursive: true })
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
echo "systemctl $*" >> "${join(dir, 'log')}"
case "$*" in
  "is-active --quiet hald.service") [ ! -f "${join(dir, 'hald-down')}" ] ;;
  "restart hald.service") [ ! -f "${join(dir, 'restart-fails')}" ] ;;
  "show -p NeedDaemonReload --value hald.service") [ -f "${join(dir, 'stale-unit')}" ] && echo yes; exit 0 ;;
esac
`)
    chmodSync(join(bin, 'systemctl'), 0o755)
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n')
    chmodSync(join(bin, 'sleep'), 0o755)
  })

  it('survives an install that dies after the new binary, and the rerun pays it', () => {
    // The first run: owed, the binary swapped, then apt or SSH takes the script down.
    run(`owe_restart "$HALD_RESTART_OWED"; exit 1`)
    expect(existsSync(hald())).toBe(true)
    expect(log()).toBe('')
    // The rerun finds the binary already in place, and still owes the restart.
    expect(run('restart_hald_if_owed').code).toBe(0)
    expect(log()).toContain('restart hald.service')
    expect(existsSync(hald())).toBe(false)
  })

  it('leaves a running hald alone when nothing is owed, so a pump run goes on', () => {
    run('restart_hald_if_owed')
    expect(log()).not.toContain('restart hald.service')
  })

  it('starts a hald that isn\'t running, owed or not', () => {
    writeFileSync(join(dir, 'hald-down'), '')
    run('restart_hald_if_owed')
    expect(log()).toContain('restart hald.service')
  })

  it('stays owed when the restart fails', () => {
    writeFileSync(join(dir, 'restart-fails'), '')
    run(`owe_restart "$HALD_RESTART_OWED"; set -e; restart_hald_if_owed`)
    expect(existsSync(hald())).toBe(true)
  })

  it('pays core\'s once, for a group joined in a run that died', () => {
    run(`owe_restart "$CORE_RESTART_OWED"; exit 1`)
    run('restart_core_if_owed')
    expect(log()).toContain('try-restart seedypod-core.service')
    expect(existsSync(core())).toBe(false)
    const before = log()
    run('restart_core_if_owed')
    expect(log()).toBe(before)
  })

  it('reloads for a unit an interrupted run wrote and never loaded', () => {
    expect(run('needs_reload hald.service').code).toBe(1)
    writeFileSync(join(dir, 'stale-unit'), '')
    expect(run('needs_reload hald.service').code).toBe(0)
  })
})
