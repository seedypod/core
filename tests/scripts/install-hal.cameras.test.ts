/**
 * install-hal's camera step, against a scratch root with stub udevadm,
 * systemctl and hald. How udev and systemd act on these files is on the
 * hardware checklist (docs/hardware/pin-map.md).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install-hal')
const RULE = 'SUBSYSTEM=="video4linux", SUBSYSTEMS=="usb", KERNELS=="1-1.3:1.0", ATTR{index}=="0", SYMLINK+="seedypod/camera-upper"\n'

let dir: string
let root: string
let rules: string

const log = () => readFileSync(join(dir, 'log'), 'utf8')

function install(hald = 'echo "camera names pinned: upper = port 1-1.3:1.0"') {
  writeFileSync(join(dir, 'bin/hald'), `#!/bin/sh\necho "hald $*" >> "$STATE/log"\n${hald}\n`)
  chmodSync(join(dir, 'bin/hald'), 0o755)
  return spawnSync('bash', ['-c', `set -euo pipefail; source "${script}"; SUDO=; install_camera_rules "${dir}/bin/hald"`], {
    encoding: 'utf8',
    env: { PATH: `${dir}/bin:/usr/bin:/bin`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: root, STATE: dir },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-hal-cameras-'))
  root = join(dir, 'root')
  rules = join(root, 'etc/udev/rules.d/70-seedypod-cameras.rules')
  mkdirSync(join(root, 'etc/udev/rules.d'), { recursive: true })
  mkdirSync(join(dir, 'bin'))
  for (const tool of ['udevadm', 'systemctl']) {
    writeFileSync(join(dir, 'bin', tool), `#!/bin/sh\necho "${tool} $*" >> "$STATE/log"\n`)
    chmodSync(join(dir, 'bin', tool), 0o755)
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('install_camera_rules', () => {
  it('sets up the step that pins names when a USB camera appears', () => {
    expect(install().status).toBe(0)
    const rule = readFileSync(join(root, 'etc/udev/rules.d/71-seedypod-camera-sync.rules'), 'utf8')
    expect(rule).toContain('ACTION=="add", SUBSYSTEM=="video4linux", SUBSYSTEMS=="usb", ATTR{index}=="0"')
    expect(rule).toContain('ENV{SYSTEMD_WANTS}+="seedypod-camera-rules.service"')
    const unit = readFileSync(join(root, 'etc/systemd/system/seedypod-camera-rules.service'), 'utf8')
    expect(unit).toContain('Type=oneshot')
    expect(unit).toContain(`ExecStart=${dir}/bin/hald --sync-camera-rules`)
  })

  it('pins what is there now and triggers with --action=add', () => {
    const r = install()
    expect(r.stdout).toContain('→ camera names pinned: upper = port 1-1.3:1.0')
    expect(log()).toContain('hald --sync-camera-rules')
    expect(log()).toContain('udevadm trigger --action=add --subsystem-match=video4linux')
  })

  it('gives the swap command with --action=add only once there are rules', () => {
    expect(install().stdout).not.toContain('If upper and lower are swapped')
    writeFileSync(rules, RULE)
    const r = install('echo "camera names already pinned"')
    expect(r.stdout).toContain('If upper and lower are swapped')
    expect(r.stdout).toContain('sudo udevadm trigger --action=add')
    expect(r.stdout).toContain('sudo tee /etc/udev/rules.d/70-seedypod-cameras.rules')
  })

  it('removes rules that named the on-chip video nodes, and leaves good ones', () => {
    writeFileSync(rules, RULE)
    install('echo waiting')
    expect(existsSync(rules)).toBe(true)
    writeFileSync(rules, 'SUBSYSTEM=="video4linux", KERNELS=="bcm2835-codec", SYMLINK+="seedypod/camera-upper"\n')
    expect(install('echo waiting').stdout).toContain('removed camera rules')
    expect(existsSync(rules)).toBe(false)
  })

  it('finishes the install when hald can\'t write the rules', () => {
    const r = install('echo "permission denied"; exit 1')
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('camera rules not written: permission denied')
    expect(r.stdout).not.toContain('→ permission denied')
  })
})
