/**
 * install-hal's USB hub recovery unit, against a scratch root with a stub
 * systemctl. What the unit does on a Pi is on the hardware checklist in
 * docs/hardware/hal.md#usb-recovery.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install-hal')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-hal-usb-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin/systemctl'), '#!/bin/sh\necho "systemctl $*" >> "$STATE/log"\n')
  chmodSync(join(dir, 'bin/systemctl'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function install(enable = 1) {
  return spawnSync('bash', ['-c', `set -euo pipefail; source "${script}"; SUDO=; install_usb_recovery /usr/local/bin/hald /etc/seedypod/hal.toml ${enable}`], {
    encoding: 'utf8',
    env: { PATH: `${dir}/bin:/usr/bin:/bin`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: join(dir, 'root'), STATE: dir },
  })
}

describe('the mark that holds off a USB hub reboot', () => {
  const mark = (steps: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "${script}"; SUDO=; ${steps}`], {
    encoding: 'utf8',
    env: { PATH: `${dir}/bin:/usr/bin:/bin`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: join(dir, 'root'), STATE: dir },
  })
  const marker = () => join(dir, 'root/run/seedypod-busy/install-hal')

  it('is there while the install runs, and gone after', () => {
    expect(mark('mark_busy install-hal').status).toBe(0)
    expect(existsSync(marker())).toBe(true)
    expect(mark('clear_busy install-hal').status).toBe(0)
    expect(existsSync(marker())).toBe(false)
  })

  it('never fails an install', () => {
    writeFileSync(join(dir, 'root'), 'not a directory')
    expect(mark('mark_busy install-hal; clear_busy install-hal').status).toBe(0)
  })
})

describe('install_usb_recovery', () => {
  it('runs once at boot, without holding up the boot or restarting', () => {
    expect(install().status).toBe(0)
    const unit = readFileSync(join(dir, 'root/etc/systemd/system/seedypod-usb-recover.service'), 'utf8')
    expect(unit).toContain('ExecStart=/usr/local/bin/hald --config /etc/seedypod/hal.toml --usb-recover')
    expect(unit).toContain('Type=simple')
    expect(unit).toContain('WantedBy=multi-user.target')
    expect(unit).not.toContain('Restart=')
  })

  it('enables it for the next boot rather than starting it now', () => {
    install()
    const log = readFileSync(join(dir, 'log'), 'utf8')
    expect(log).toContain('systemctl enable seedypod-usb-recover.service')
    expect(log).not.toContain('start seedypod-usb-recover')
  })

  it('writes the unit but leaves it off with --no-enable, like hald.service', () => {
    expect(install(0).stdout).toBe('')
    expect(readFileSync(join(dir, 'root/etc/systemd/system/seedypod-usb-recover.service'), 'utf8')).toContain('--usb-recover')
    expect(readFileSync(join(dir, 'log'), 'utf8')).not.toContain('enable')
  })
})
