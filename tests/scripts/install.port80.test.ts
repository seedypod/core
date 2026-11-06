/**
 * scripts/install's forward from port 80 to core, against a scratch root with
 * stub sudo, systemctl and apt-get. The rule itself needs a kernel, so how it
 * behaves is checked on a real unit.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install')
const RULES = 'usr/local/share/seedypod/port80.nft'
const UNIT = 'etc/systemd/system/seedypod-port80.service'
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const listening = (port: string, state = '0A') => `   0: 00000000:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 1 1 00000000 100 0 0 10 0\n`

const STUBS: Record<string, string> = {
  'sudo': 'exec "$@"',
  'systemctl': `echo "systemctl $*" >> "$STATE/log"
case "$*" in
  "restart seedypod-port80.service") [ ! -f "$STATE/fail-start" ] ;;
esac`,
  'apt-get': `echo "apt-get $*" >> "$STATE/log"
[ -f "$STATE/fail-apt" ] && exit 100
mkdir -p "$SEEDYPOD_ROOT/usr/sbin"; : > "$SEEDYPOD_ROOT/usr/sbin/nft"; chmod +x "$SEEDYPOD_ROOT/usr/sbin/nft"`,
}

let dir: string
let root: string
let state: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-port80-'))
  root = join(dir, 'root')
  state = join(dir, 'state')
  bin = join(dir, 'bin')
  for (const d of ['usr/sbin', 'etc/systemd/system', 'proc/net', 'proc/device-tree']) mkdirSync(join(root, d), { recursive: true })
  for (const d of [state, bin]) mkdirSync(d)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  // What nft says about the table, however active systemd thinks the oneshot is.
  writeFileSync(join(root, 'usr/sbin/nft'), '#!/bin/sh\n[ ! -f "$STATE/port80-down" ]\n')
  chmodSync(join(root, 'usr/sbin/nft'), 0o755)
  writeFileSync(join(root, 'proc/net/tcp'), HEADER + listening('0BB8'))
  writeFileSync(join(root, 'proc/net/tcp6'), HEADER)
  onBoard('Raspberry Pi Zero W Rev 1.1')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const onBoard = (model: string) => writeFileSync(join(root, 'proc/device-tree/model'), `${model}\0`)
const flag = (name: string) => writeFileSync(join(state, name), '')
const log = () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '')
const forwarding = () => existsSync(join(root, RULES)) && existsSync(join(root, UNIT))
const env = () => ({ PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_ROOT: root, STATE: state })

/** What a whole install does. */
function install() {
  const r = spawnSync('bash', ['-c', `source "${script}"; install_port80`], { encoding: 'utf8', env: { ...env(), SEEDYPOD_LIB_ONLY: '1' } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function flagged(arg: string) {
  const r = spawnSync('bash', [script, arg], { encoding: 'utf8', env: env() })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('on a Raspberry Pi', () => {
  it('redirects port 80 for this machine\'s addresses to 3000, from a unit that survives a reboot', () => {
    const r = install()
    expect(r).toMatchObject({ code: 0 })
    expect(r.out).toContain('port 80 forwards to core')
    const rules = readFileSync(join(root, RULES), 'utf8')
    expect(rules).toContain('fib daddr type local tcp dport 80 redirect to :3000')
    expect(rules).toContain('hook prerouting')
    const unit = readFileSync(join(root, UNIT), 'utf8')
    expect(unit).toContain('ExecStart=/usr/sbin/nft -f /usr/local/share/seedypod/port80.nft')
    expect(unit).toContain('ExecStop=/usr/sbin/nft delete table ip seedypod')
    expect(unit).toContain('WantedBy=multi-user.target')
    expect(log()).toContain('systemctl enable seedypod-port80.service')
    expect(log()).toContain('systemctl restart seedypod-port80.service')
  })

  it('leaves a working forward alone on a rerun, with no reload', () => {
    install()
    const before = log()
    const r = install()
    expect(r.out).toContain('port 80 already forwards to core')
    expect(log().replace(before, '')).not.toMatch(/daemon-reload|restart/)
  })

  it('brings the forward back on a rerun after something flushed the table, with rules that replace themselves', () => {
    install()
    flag('port80-down')
    install()
    expect(log().match(/restart seedypod-port80/g)).toHaveLength(2)
    expect(readFileSync(join(root, RULES), 'utf8')).toContain('delete table ip seedypod')
  })

  it('doesn\'t pass off a failed write as nothing to do', () => {
    install()
    writeFileSync(join(root, RULES), 'older rules\n')
    writeFileSync(join(bin, 'tee'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(bin, 'tee'), 0o755)
    const r = install()
    expect(r.code).toBe(1)
    expect(r.err).toContain('couldn\'t write')
  })

  it('reapplies rules a new version changed', () => {
    install()
    writeFileSync(join(root, RULES), 'older rules\n')
    install()
    expect(log().match(/restart seedypod-port80/g)).toHaveLength(2)
    expect(readFileSync(join(root, RULES), 'utf8')).toContain('redirect to :3000')
  })

  it('installs nftables if the OS came without it', () => {
    rmSync(join(root, 'usr/sbin/nft'))
    expect(install().code).toBe(0)
    expect(log()).toContain('apt-get install -y -q nftables')
    expect(forwarding()).toBe(true)
  })

  it('reports failure and leaves nothing behind without nftables', () => {
    rmSync(join(root, 'usr/sbin/nft'))
    flag('fail-apt')
    const r = install()
    expect(r.code).toBe(1)
    expect(r.err).toContain('no nftables')
    expect(forwarding()).toBe(false)
  })

  it('takes everything back out if the rule won\'t load', () => {
    flag('fail-start')
    expect(install().code).toBe(1)
    expect(forwarding()).toBe(false)
    expect(log()).toContain('systemctl disable --now seedypod-port80.service')
  })
})

describe('when something else owns port 80', () => {
  it('skips it, for an IPv4 or an IPv6 listener', () => {
    for (const file of ['tcp', 'tcp6']) {
      writeFileSync(join(root, 'proc/net', file), HEADER + listening('0050'))
      const r = install()
      expect(r.code).toBe(0)
      expect(r.err).toContain('something else listens on port 80')
      expect(forwarding()).toBe(false)
      writeFileSync(join(root, 'proc/net', file), HEADER)
    }
  })

  it('gives the port up on a rerun rather than shadow it', () => {
    install()
    writeFileSync(join(root, 'proc/net/tcp'), HEADER + listening('0050'))
    expect(install().code).toBe(0)
    expect(forwarding()).toBe(false)
    expect(log()).toContain('systemctl disable --now seedypod-port80.service')
  })

  it('isn\'t fooled by other ports, or by a connection that isn\'t listening', () => {
    writeFileSync(join(root, 'proc/net/tcp'), HEADER + listening('1F90') + listening('0050', '01'))
    install()
    expect(forwarding()).toBe(true)
  })

  it('copes with no IPv6', () => {
    rmSync(join(root, 'proc/net/tcp6'))
    writeFileSync(join(root, 'proc/net/tcp'), HEADER + listening('0050'))
    install()
    expect(forwarding()).toBe(false)
  })
})

describe('on another machine', () => {
  it('leaves port 80 alone and says how to opt in', () => {
    rmSync(join(root, 'proc/device-tree/model'))
    const r = install()
    expect(r.code).toBe(0)
    expect(r.out).toContain('scripts/install --port80')
    expect(forwarding()).toBe(false)
    expect(log()).toBe('')
  })

  it('doesn\'t read a Pi into another board\'s model', () => {
    onBoard('Orange Pi Zero 3')
    install()
    expect(forwarding()).toBe(false)
  })

  it('opts in with --port80, and stays in on later installs', () => {
    onBoard('Orange Pi Zero 3')
    expect(flagged('--port80').code).toBe(0)
    expect(forwarding()).toBe(true)
    install()
    expect(forwarding()).toBe(true)
  })
})

describe('--no-port80', () => {
  it('removes the forward and keeps it off when the install runs again', () => {
    install()
    expect(flagged('--no-port80').code).toBe(0)
    expect(forwarding()).toBe(false)
    expect(log()).toContain('systemctl disable --now seedypod-port80.service')
    install()
    expect(forwarding()).toBe(false)
  })

  it('is undone by --port80', () => {
    flagged('--no-port80')
    flagged('--port80')
    expect(forwarding()).toBe(true)
    install()
    expect(forwarding()).toBe(true)
  })
})
