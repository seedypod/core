/**
 * install-hal's boot settings, run against a scratch root with stub
 * systemctl/nmcli so each change and its rollback can be checked without a Pi.
 * The units they react to are taken from Raspberry Pi OS trixie's packages
 * (cloud-init, netplan-generator, rpi-swap, mosquitto).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install-hal')

const STUBS: Record<string, string> = {
  systemctl: `echo "systemctl $*" >> "$STATE/log"
case "$*" in
  daemon-reload) [ -f "$STATE/fail-reload" ] && exit 1; exit 0 ;;
  "cat dev-zram0.swap") [ -f "$STATE/fail-zram-unit" ] && exit 1; exit 0 ;;
  "show -p Requires --value systemd-zram-setup@zram0.service") [ -f "$STATE/still-looped" ] && echo rpi-setup-loop@var-swap.service; exit 0 ;;
  "show -p After --value mosquitto.service") [ -f "$STATE/still-waits" ] && echo network-online.target; exit 0 ;;
esac
exit 0`,
  nmcli: `echo "nmcli $*" >> "$STATE/log"
[ -f "$STATE/fail-nmcli" ] && exit 8
if [ -f "$STATE/gone-after-reload" ] && grep -q daemon-reload "$STATE/log"; then exit 0; fi
cat "$STATE/active" 2>/dev/null`,
}

const LO = 'loopback:/run/NetworkManager/system-connections/lo.nmconnection'
const IMAGER_WIFI = '802-11-wireless:/run/NetworkManager/system-connections/netplan-NM-1234.nmconnection'
const MOSQ_VENDOR = `[Unit]
Description=Mosquitto MQTT Broker
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/sbin/mosquitto -c /etc/mosquitto/mosquitto.conf
`

let dir: string
let root: string
let state: string
let bin: string

const put = (p: string, body = '') => {
  mkdirSync(dirname(join(root, p)), { recursive: true })
  writeFileSync(join(root, p), body)
}
const flag = (name: string) => writeFileSync(join(state, name), '')
const active = (...lines: string[]) => writeFileSync(join(state, 'active'), `${lines.join('\n')}\n`)
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const has = (p: string) => existsSync(join(root, p))
const log = () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '')

function run(fn: string) {
  const r = spawnSync('bash', ['-c', `source "${script}"; SUDO=; ${fn}`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, SEEDYPOD_LIB_ONLY: '1', SEEDYPOD_ROOT: root, STATE: state },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seedypod-boot-'))
  root = join(dir, 'root')
  state = join(dir, 'state')
  bin = join(dir, 'bin')
  for (const d of [root, state, bin, join(root, 'etc/systemd/system')]) mkdirSync(d, { recursive: true })
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('cloud-init off after first boot', () => {
  const disabled = 'etc/cloud/cloud-init.disabled'
  const imagerUnit = () => {
    put('var/lib/cloud/instance/boot-finished')
    put('etc/netplan/50-cloud-init.yaml', 'network: {}\n')
    put('usr/lib/systemd/system-generators/netplan')
    mkdirSync(join(root, 'etc/cloud'), { recursive: true })
    active(LO, IMAGER_WIFI)
  }

  it('turns it off when Imager\'s Wi-Fi comes back through netplan', () => {
    imagerUnit()
    const r = run('boot_cloud_init')
    expect(r.code).toBe(0)
    expect(has(disabled)).toBe(true)
    expect(r.out).toContain('cloud-init off')
  })

  it('turns it off for a keyfile in /etc, which needs nothing else', () => {
    imagerUnit()
    active('802-11-wireless:/etc/NetworkManager/system-connections/home.nmconnection')
    rmSync(join(root, 'etc/netplan'), { recursive: true })
    expect(run('boot_cloud_init').code).toBe(0)
    expect(has(disabled)).toBe(true)
  })

  it('does nothing on an OS without cloud-init', () => {
    expect(run('boot_cloud_init')).toMatchObject({ code: 0, out: '' })
    expect(log()).toBe('')
  })

  it('is a no-op on a rerun', () => {
    imagerUnit()
    run('boot_cloud_init')
    const before = log()
    expect(run('boot_cloud_init').out).toContain('already off')
    expect(log()).toBe(before)
  })

  it('waits for first boot to finish', () => {
    imagerUnit()
    rmSync(join(root, 'var/lib/cloud/instance/boot-finished'))
    const r = run('boot_cloud_init')
    expect(r.code).toBe(1)
    expect(has(disabled)).toBe(false)
    expect(r.err).toContain('hasn\'t finished first boot')
  })

  it.each([
    ['nmcli fails', () => flag('fail-nmcli')],
    ['nothing but loopback is up', () => active(LO)],
    ['nothing at all is up', () => active('')],
    ['the connection only lives in memory', () => active('802-3-ethernet:')],
    ['a /run connection isn\'t netplan\'s', () => active('802-11-wireless:/run/NetworkManager/system-connections/other.nmconnection')],
    ['netplan has no config', () => rmSync(join(root, 'etc/netplan'), { recursive: true })],
    ['netplan has no generator', () => rmSync(join(root, 'usr/lib/systemd/system-generators/netplan'))],
    ['one of two connections can\'t be shown to return', () => active(IMAGER_WIFI, '802-3-ethernet:')],
  ])('leaves it on when %s', (_, arrange) => {
    imagerUnit()
    arrange()
    const r = run('boot_cloud_init')
    expect(r.code).toBe(1)
    expect(has(disabled)).toBe(false)
    expect(r.err).toContain('left on')
  })

  it.each(['fail-reload', 'gone-after-reload'])('rolls back on %s', (failure) => {
    imagerUnit()
    flag(failure)
    const r = run('boot_cloud_init')
    expect(r.code).toBe(1)
    expect(has(disabled)).toBe(false)
    expect(r.err).toContain('didn\'t take')
  })
})

describe('swap without a file on the card', () => {
  const conf = 'etc/rpi/swap.conf.d/50-seedypod.conf'
  const rpiSwap = () => put('usr/lib/systemd/system-generators/rpi-swap-generator')

  it('sets zram alone', () => {
    rpiSwap()
    const r = run('boot_swap')
    expect(r.code).toBe(0)
    expect(read(conf)).toContain('[Main]\nMechanism=zram')
    expect(log()).toContain('systemctl daemon-reload')
  })

  it('does nothing without rpi-swap', () => {
    expect(run('boot_swap')).toMatchObject({ code: 0, out: '' })
    expect(has(conf)).toBe(false)
  })

  it('is a no-op on a rerun', () => {
    rpiSwap()
    run('boot_swap')
    const before = log()
    expect(run('boot_swap').out).toContain('already zram alone')
    expect(log()).toBe(before)
  })

  it('keeps a Mechanism someone chose', () => {
    rpiSwap()
    put('etc/rpi/swap.conf', '[Main]\nMechanism=swapfile\n')
    expect(run('boot_swap').out).toContain('left alone')
    expect(has(conf)).toBe(false)
  })

  it('ignores the commented default in swap.conf', () => {
    rpiSwap()
    put('etc/rpi/swap.conf', '[Main]\n#Mechanism=auto\n')
    expect(run('boot_swap').code).toBe(0)
    expect(has(conf)).toBe(true)
  })

  it.each(['fail-reload', 'fail-zram-unit', 'still-looped'])('rolls back on %s', (failure) => {
    rpiSwap()
    flag(failure)
    const r = run('boot_swap')
    expect(r.code).toBe(1)
    expect(has(conf)).toBe(false)
    expect(r.err).toContain('swap left as it was')
  })
})

describe('Mosquitto without network-online', () => {
  const unit = 'etc/systemd/system/mosquitto.service'
  const vendor = () => put('usr/lib/systemd/system/mosquitto.service', MOSQ_VENDOR)

  it('copies the vendor unit without the network wait', () => {
    vendor()
    const r = run('boot_broker')
    expect(r.code).toBe(0)
    expect(read(unit)).not.toContain('network-online')
    expect(read(unit)).toContain('ExecStart=/usr/sbin/mosquitto -c /etc/mosquitto/mosquitto.conf')
  })

  it('does nothing without Mosquitto (--no-broker)', () => {
    expect(run('boot_broker')).toMatchObject({ code: 0, out: '' })
    expect(has(unit)).toBe(false)
  })

  it('is a no-op on a rerun, and follows a changed vendor unit', () => {
    vendor()
    run('boot_broker')
    const before = log()
    expect(run('boot_broker').out).toContain('already starts')
    expect(log()).toBe(before)
    put('usr/lib/systemd/system/mosquitto.service', MOSQ_VENDOR.replace('Type=notify', 'Type=notify\nRestart=on-failure'))
    run('boot_broker')
    expect(read(unit)).toContain('Restart=on-failure')
  })

  it.each(['fail-reload', 'still-waits'])('rolls back on %s', (failure) => {
    vendor()
    flag(failure)
    const r = run('boot_broker')
    expect(r.code).toBe(1)
    expect(has(unit)).toBe(false)
    expect(r.err).toContain('left it as it was')
  })
})

describe('apply_boot_settings', () => {
  it('carries on past a failure and says so', () => {
    put('usr/lib/systemd/system/mosquitto.service', MOSQ_VENDOR)
    mkdirSync(join(root, 'etc/cloud'), { recursive: true })
    const r = run('apply_boot_settings')
    expect(r.code).toBe(0)
    expect(r.err).toContain('some boot settings were skipped')
    expect(has('etc/systemd/system/mosquitto.service')).toBe(true)
  })

  it('leaves swap alone under --no-wear', () => {
    put('usr/lib/systemd/system-generators/rpi-swap-generator')
    run('WEAR=0; apply_boot_settings')
    expect(has('etc/rpi/swap.conf.d/50-seedypod.conf')).toBe(false)
  })
})

describe('the units', () => {
  it('holds hald for its hardware, for a bounded time, then starts regardless', () => {
    const text = readFileSync(script, 'utf8')
    const wait = text.match(/^ExecStartPre=(-\/usr\/bin\/timeout 30 .*)$/m)?.[1] ?? ''
    expect(wait).toContain('/sys/class/pwm/pwmchip0')
    expect(wait).toContain('/dev/i2c-')
  })

  it.each(['scripts/install-hal', 'scripts/install'])('%s doesn\'t hold hald or core for the network', (file) => {
    const text = readFileSync(resolve(import.meta.dirname, '../..', file), 'utf8')
    expect(text).not.toMatch(/^(After|Wants)=.*network-online/m)
  })
})
