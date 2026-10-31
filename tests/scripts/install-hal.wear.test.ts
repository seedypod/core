/**
 * install-hal's SD card settings (ADR-0021), run against a scratch root with
 * stub systemctl/swapon/mount/findmnt/apt-get so each change and its rollback
 * can be checked without a Pi. How Raspberry Pi OS itself takes them is on
 * the hardware checklist (docs/hardware/pin-map.md).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install-hal')

// Each stub logs its arguments and reads its behaviour from files under $STATE.
const STUBS: Record<string, string> = {
  'systemctl': `echo "systemctl $*" >> "$STATE/log"
case "$*" in
  "restart systemd-journald") [ -f "$STATE/fail-journald" ] && grep -q volatile "$SEEDYPOD_ROOT/etc/systemd/journald.conf.d/"*.conf 2>/dev/null && exit 1; exit 0 ;;
  "is-active --quiet systemd-journald") [ -f "$STATE/fail-journald" ] && grep -q volatile "$SEEDYPOD_ROOT/etc/systemd/journald.conf.d/"*.conf 2>/dev/null && exit 3; exit 0 ;;
  "start dev-zram0.swap") [ -f "$STATE/fail-zram" ] && exit 1; touch "$STATE/zram-on" ;;
  "stop dev-zram0.swap") rm -f "$STATE/zram-on" ;;
esac
exit 0`,
  'swapon': `[ -f "$STATE/zram-on" ] && echo /dev/zram0
[ -f "$STATE/dphys-on" ] && echo /var/swap
exit 0`,
  'dphys-swapfile': `echo "dphys-swapfile $*" >> "$STATE/log"; [ "$1" = swapoff ] && rm -f "$STATE/dphys-on"; exit 0`,
  'apt-get': `echo "apt-get $*" >> "$STATE/log"
[ -f "$STATE/fail-apt" ] && exit 100
mkdir -p "$SEEDYPOD_ROOT/usr/lib/systemd/system-generators"
printf '#!/bin/sh\\n' > "$SEEDYPOD_ROOT/usr/lib/systemd/system-generators/zram-generator"
chmod +x "$SEEDYPOD_ROOT/usr/lib/systemd/system-generators/zram-generator"`,
  'mount': `echo "mount $*" >> "$STATE/log"
if [ "$*" = "-o remount,noatime /" ]; then [ -f "$STATE/fail-remount" ] && exit 32; echo rw,noatime > "$STATE/root-opts"; fi
exit 0`,
  'findmnt': `if [ "$1" = --verify ]; then [ -f "$STATE/fail-verify" ] && exit 1; exit 0; fi
cat "$STATE/root-opts" 2>/dev/null || echo rw,relatime`,
}

const FSTAB = `proc            /proc           proc    defaults          0       0
PARTUUID=abcd-01  /boot/firmware  vfat    defaults          0       2
PARTUUID=abcd-02  /               ext4    defaults          0       1
`

let dir: string
let root: string
let state: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seedypod-wear-'))
  root = join(dir, 'root')
  state = join(dir, 'state')
  bin = join(dir, 'bin')
  for (const d of [root, state, bin, join(root, 'etc')]) mkdirSync(d, { recursive: true })
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(root, 'etc/fstab'), FSTAB)
  writeFileSync(join(state, 'dphys-on'), '')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const flag = (name: string) => writeFileSync(join(state, name), '')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const log = () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '')

function run(fn: string) {
  const r = spawnSync('bash', ['-c', `source "${script}"; SUDO=; ${fn}`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: root, STATE: state },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('journal in RAM', () => {
  it('writes the volatile drop-in and restarts journald', () => {
    const r = run('wear_journald')
    expect(r.code).toBe(0)
    expect(read('etc/systemd/journald.conf.d/50-seedypod-volatile.conf')).toContain('Storage=volatile\nRuntimeMaxUse=32M')
    expect(log()).toContain('systemctl restart systemd-journald')
  })

  it('is a no-op on a rerun', () => {
    run('wear_journald')
    const r = run('wear_journald')
    expect(r.out).toContain('already kept in RAM')
    expect(log().match(/restart systemd-journald/g)).toHaveLength(1)
  })

  it('removes the drop-in when journald fails to come back with it', () => {
    flag('fail-journald')
    const r = run('wear_journald')
    expect(r.code).toBe(1)
    expect(existsSync(join(root, 'etc/systemd/journald.conf.d/50-seedypod-volatile.conf'))).toBe(false)
    expect(r.err).toContain('didn\'t take')
  })
})

describe('swap on zram', () => {
  it('installs the generator, starts zram, then turns the SD swapfile off', () => {
    const r = run('wear_swap')
    expect(r.code).toBe(0)
    expect(log()).toContain('apt-get install -y -q systemd-zram-generator')
    expect(read('etc/systemd/zram-generator.conf')).toContain('[zram0]')
    const lines = log().split('\n')
    expect(lines.indexOf('systemctl start dev-zram0.swap')).toBeLessThan(lines.indexOf('dphys-swapfile swapoff'))
    expect(log()).toContain('systemctl disable --now dphys-swapfile')
  })

  it('leaves the SD swapfile alone when zram does not start', () => {
    flag('fail-zram')
    const r = run('wear_swap')
    expect(r.code).toBe(1)
    expect(existsSync(join(root, 'etc/systemd/zram-generator.conf'))).toBe(false)
    expect(log()).not.toContain('dphys-swapfile')
    expect(existsSync(join(state, 'dphys-on'))).toBe(true)
  })

  it('gives up cleanly without the generator package', () => {
    flag('fail-apt')
    const r = run('wear_swap')
    expect(r.code).toBe(1)
    expect(log()).not.toContain('dphys-swapfile')
    expect(r.err).toContain('zram isn\'t available')
  })

  it('only retires dphys-swapfile when zram is already on (Raspberry Pi OS with rpi-swap)', () => {
    flag('zram-on')
    const r = run('wear_swap')
    expect(r.out).toContain('swap already on zram')
    expect(log()).not.toContain('apt-get')
    expect(log()).toContain('dphys-swapfile uninstall')
  })
})

describe('noatime on /', () => {
  it('adds noatime to the root entry only and remounts', () => {
    const r = run('wear_noatime')
    expect(r.code).toBe(0)
    const fstab = read('etc/fstab').split('\n')
    expect(fstab[2]).toMatch(/^PARTUUID=abcd-02\s+\/\s+ext4\s+defaults,noatime\s+0\s+1$/)
    expect(fstab[1]).toBe(FSTAB.split('\n')[1])
    expect(log()).toContain('mount -o remount,noatime /')
    expect(existsSync(join(root, 'etc/fstab.seedypod-bak'))).toBe(false)
  })

  it('skips an fstab that already has it (stock Raspberry Pi OS)', () => {
    writeFileSync(join(root, 'etc/fstab'), FSTAB.replace('ext4    defaults ', 'ext4    defaults,noatime '))
    const r = run('wear_noatime')
    expect(r.out).toContain('already mounted noatime')
    expect(log()).toBe('')
  })

  it('restores fstab when the remount fails', () => {
    flag('fail-remount')
    const r = run('wear_noatime')
    expect(r.code).toBe(1)
    expect(read('etc/fstab')).toBe(FSTAB)
    expect(log()).toContain('mount -o remount /')
  })

  it('restores fstab when findmnt rejects the edited file', () => {
    flag('fail-verify')
    const r = run('wear_noatime')
    expect(r.code).toBe(1)
    expect(read('etc/fstab')).toBe(FSTAB)
    expect(log()).not.toContain('remount,noatime')
  })
})

it('applies the rest when one setting fails, and never fails the install', () => {
  flag('fail-zram')
  const r = run('apply_wear_settings')
  expect(r.code).toBe(0)
  expect(existsSync(join(root, 'etc/systemd/journald.conf.d/50-seedypod-volatile.conf'))).toBe(true)
  expect(read('etc/fstab')).toContain('defaults,noatime')
  expect(existsSync(join(root, 'etc/systemd/zram-generator.conf'))).toBe(false)
  expect(r.err).toContain('some SD card settings were skipped')
})
