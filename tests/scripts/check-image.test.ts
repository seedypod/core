/**
 * scripts/check-image, on a stand-in download and on a card's boot partition as
 * Raspberry Pi Imager leaves it. xz is stubbed; the partition table is real bytes.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/check-image')
// What Imager 2.0 writes, from rpi-imager's customization_generator.cpp.
const USER_DATA = `#cloud-config
hostname: "seedypod"
manage_etc_hosts: true
packages:
- avahi-daemon

user:
  name: "alice"
  shell: /bin/bash
  lock_passwd: false
  passwd: "$5$salt$hash"
  sudo: null

ssh_pwauth: true

runcmd:
  - [ systemctl, enable, --now, ssh ]
  - [ rfkill, unblock, wifi ]
`
const NETWORK_CONFIG = `network:
  version: 2
  ethernets:
    eth0:
      dhcp4: true
      dhcp6: true
      optional: true
  wifis:
    wlan0:
      dhcp4: true
      regulatory-domain: "US"
      access-points:
        "Home Network":
          password: "abc"
      optional: true
`

let dir: string
let boot: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-image-'))
  boot = join(dir, 'bootfs')
  bin = join(dir, 'bin')
  for (const d of [boot, bin]) mkdirSync(d)
  writeFileSync(join(bin, 'xz'), `#!/bin/sh
case "$1" in
  -t) [ ! -f "$XZ_DAMAGED" ] ;;
  -dc) cat "$2" ;;
esac
`)
  chmodSync(join(bin, 'xz'), 0o755)
  writeFileSync(join(boot, 'config.txt'), 'auto_initramfs=1\n')
  writeFileSync(join(boot, 'kernel.img'), '')
  writeFileSync(join(boot, 'seedypod-image.txt'), 'branch=dev\ncommit=83c4b1e0123456789\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function check(...args: string[]) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, XZ_DAMAGED: join(dir, 'damaged') },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function download(types = [0x0C, 0x83]) {
  const image = join(dir, 'seedypod-os.img.xz')
  const mbr = Buffer.alloc(512)
  types.forEach((t, i) => (mbr[446 + i * 16 + 4] = t))
  mbr[510] = 0x55
  mbr[511] = 0xAA
  writeFileSync(image, mbr)
  writeFileSync(`${image}.sha256`, `${createHash('sha256').update(mbr).digest('hex')}  seedypod-os.img.xz\n`)
  return image
}

describe('a download, before flashing', () => {
  it('passes when it matches its sha256 and holds both partitions', () => {
    const r = check(download())
    expect(r).toMatchObject({ code: 0, err: '' })
    expect(r.out).toContain('sha256 matches')
    expect(r.out).toContain('a boot partition and a root partition')
  })

  it('fails a download that doesn\'t match', () => {
    const image = download()
    writeFileSync(image, `${readFileSync(image)}x`)
    const r = check(image)
    expect(r.code).toBe(1)
    expect(r.err).toContain('sha256 doesn\'t match')
  })

  it('fails with nothing to check against', () => {
    const image = download()
    rmSync(`${image}.sha256`)
    expect(check(image).code).toBe(1)
  })

  it('fails a damaged archive', () => {
    const image = download()
    writeFileSync(join(dir, 'damaged'), '')
    const r = check(image)
    expect(r.code).toBe(1)
    expect(r.err).toContain('damaged')
  })

  it('fails what isn\'t a Raspberry Pi OS image', () => {
    expect(check(download([0xEE, 0x00])).err).toContain('isn\'t a Raspberry Pi OS image')
  })
})

describe('a card, before its first boot', () => {
  it('reads the login and Wi-Fi Imager wrote', () => {
    writeFileSync(join(boot, 'user-data'), USER_DATA)
    writeFileSync(join(boot, 'network-config'), NETWORK_CONFIG)
    const r = check('--card', boot)
    expect(r).toMatchObject({ code: 0, err: '' })
    expect(r.out).toContain('seedypod OS, dev 83c4b1e')
    expect(r.out).toContain('login: alice')
    expect(r.out).toContain('Wi-Fi: Home Network')
  })

  it('says what to expect with neither, which is still a working card', () => {
    writeFileSync(join(boot, 'user-data'), '#cloud-config\n#users:\n#- name: robot\n')
    writeFileSync(join(boot, 'network-config'), '#network:\n#  wifis:\n')
    const r = check('--card', boot)
    expect(r.code).toBe(0)
    expect(r.out).toContain('no login set')
    expect(r.out).toContain('seedypod-setup-xxxx')
  })

  it('catches a 64-bit OS, which a Pi Zero W never boots and gives no error', () => {
    rmSync(join(boot, 'kernel.img'))
    writeFileSync(join(boot, 'config.txt'), 'arm_64bit=1\n')
    const r = check('--card', boot)
    expect(r.code).toBe(1)
    expect(r.err).toContain('no kernel.img')
    expect(r.err).toContain('arm_64bit=1')
  })

  it('tells stock Raspberry Pi OS from seedypod OS', () => {
    rmSync(join(boot, 'seedypod-image.txt'))
    expect(check('--card', boot).out).toContain('not seedypod OS')
  })

  it('says so when that isn\'t a boot partition', () => {
    rmSync(join(boot, 'config.txt'))
    expect(check('--card', boot).err).toContain('isn\'t a Raspberry Pi boot partition')
  })
})

describe('usage', () => {
  it('prints it with nothing to check', () => {
    expect(check().code).toBe(2)
  })
})
