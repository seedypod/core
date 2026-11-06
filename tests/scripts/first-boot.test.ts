/**
 * What the OS image does on its first boots, against a scratch root with stub hald,
 * systemctl and rfkill. scripts/image/verify covers what the build leaves
 * in place; booting it on a card is the first-boot checklist in docs/INSTALLATION.md.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const scripts = resolve(import.meta.dirname, '../../scripts')
const UNIT = 'etc/systemd/system/seedypod-core.service'

const STUBS: Record<string, string> = {
  systemctl: 'echo "systemctl $*" >> "$STATE/log"',
  rfkill: 'echo "rfkill $*" >> "$STATE/log"',
  findmnt: 'exit 0',
  mount: 'exit 0',
  hald: '[ -f "$STATE/no-id" ] || echo \'{ "unit_id": "gardyn-db753a85" }\'',
}

let dir: string
let root: string
let state: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'first-boot-'))
  root = join(dir, 'root')
  state = join(dir, 'state')
  bin = join(dir, 'bin')
  for (const d of ['etc/systemd/system', 'proc']) mkdirSync(join(root, d), { recursive: true })
  for (const d of [state, bin]) mkdirSync(d)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(root, UNIT), 'Environment=HAL_MQTT_URL=mqtt://127.0.0.1:1883 HAL_UNIT_ID=__UNIT_ID__\nUser=seedypod-core\n')
  writeFileSync(join(root, 'etc/fstab'), 'PARTUUID=1-02 / ext4 defaults,noatime 0 1\n')
  writeFileSync(join(root, 'proc/swaps'), '/dev/zram0 partition 1 0 100\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function boot() {
  const r = spawnSync('bash', [join(scripts, 'image/first-boot')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_ROOT: root, SEEDYPOD_IMAGE_LIB: scripts, STATE: state },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const log = () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '')
const unit = () => readFileSync(join(root, UNIT), 'utf8')

describe('the first boot', () => {
  it('points core at this Pi\'s hald, and tells systemd before core starts', () => {
    expect(boot().code).toBe(0)
    expect(unit()).toContain('HAL_UNIT_ID=gardyn-db753a85\n')
    expect(log()).toContain('systemctl daemon-reload')
  })

  it('unblocks Wi-Fi, so the setup hotspot works on a card with no network set', () => {
    boot()
    expect(log()).toContain('rfkill unblock wifi')
  })

  it('applies the installer\'s SD card settings, on a running system', () => {
    boot()
    expect(readFileSync(join(root, 'etc/systemd/journald.conf.d/50-seedypod-volatile.conf'), 'utf8')).toContain('Storage=volatile')
    expect(log()).toContain('systemctl restart systemd-journald')
  })

  it('turns itself off, so later boots leave it all alone', () => {
    boot()
    expect(log()).toContain('systemctl disable seedypod-first-boot.service')
  })

  it('tries again next boot when hald gives no unit id, and core keeps no made-up one', () => {
    writeFileSync(join(state, 'no-id'), '')
    expect(boot().code).toBe(1)
    expect(unit()).toContain('HAL_UNIT_ID=__UNIT_ID__')
    expect(log()).not.toContain('disable seedypod-first-boot.service')
    rmSync(join(state, 'no-id'))
    boot()
    expect(unit()).toContain('HAL_UNIT_ID=gardyn-db753a85\n')
    expect(log()).toContain('disable seedypod-first-boot.service')
  })
})
