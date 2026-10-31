import { describe, expect, it } from 'vitest'
import { NmcliWifi, parseScan, SimWifi, splitTerse, validateCredentials } from '../wifi'

/** A scripted nmcli: answers by the first matching argument prefix and records every call. */
function fakeNmcli(answers: Array<[string, string | Error]>) {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    const line = args.join(' ')
    const hit = answers.find(([prefix]) => line.startsWith(prefix))
    if (!hit) return ''
    if (hit[1] instanceof Error) throw hit[1]
    return hit[1]
  }
  return { run, calls, line: (i: number) => calls[i]?.join(' ') }
}

function manual() {
  const jobs: Array<{ fn: () => void, ms: number }> = []
  return { jobs, schedule: (fn: () => void, ms: number) => jobs.push({ fn, ms }), cancel: () => undefined }
}

const now = () => new Date('2026-10-31T12:00:00Z')

describe('nmcli parsing', () => {
  it('splits terse output on unescaped colons', () => {
    expect(splitTerse('*:My\\:Net:72:WPA2')).toEqual(['*', 'My:Net', '72', 'WPA2'])
    expect(splitTerse('a\\\\b:c')).toEqual(['a\\b', 'c'])
  })

  it('dedupes access points per network, keeps the strongest, puts the current one first', () => {
    const nets = parseScan([' :Home:40:WPA2', '*:Home:35:WPA2', ' :Cafe:90:', ' ::70:WPA2', ' :Lab:55:--', ''].join('\n'))
    expect(nets).toEqual([
      { ssid: 'Home', signal: 40, secure: true, inUse: true },
      { ssid: 'Cafe', signal: 90, secure: false, inUse: false },
      { ssid: 'Lab', signal: 55, secure: false, inUse: false },
    ])
  })

  it('validates names and WPA passwords', () => {
    expect(validateCredentials('', 'password1')).toMatch(/1–32 bytes/)
    expect(validateCredentials('x'.repeat(33))).toMatch(/1–32 bytes/)
    expect(validateCredentials('Home', 'short')).toMatch(/8–63/)
    expect(validateCredentials('Home', 'p'.repeat(64))).toMatch(/8–63/)
    expect(validateCredentials('Home')).toBeNull()
    expect(validateCredentials('Home', 'longenough')).toBeNull()
  })
})

const failing = (message: string) => async (): Promise<string> => {
  throw new Error(message)
}

describe('NmcliWifi', () => {
  it('reports a connected client with its network and address', async () => {
    const nm = fakeNmcli([
      ['-t -f GENERAL.STATE', 'GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:seedypod-wifi\nIP4.ADDRESS[1]:192.168.1.40/24\n'],
      ['-t -f ACTIVE,SSID', 'no:Cafe\nyes:Home\\:Net\n'],
    ])
    const w = new NmcliWifi({ run: nm.run, unitId: 'gardyn-AB12', now })
    expect(await w.status()).toEqual({ available: true, mode: 'client', ssid: 'Home:Net', ip: '192.168.1.40', setup: null, lastError: null })
    expect(w.setupSsid).toBe('seedypod-setup-ab12')
  })

  it('is unavailable without nmcli and offline when disconnected', async () => {
    const gone = new NmcliWifi({ run: failing('spawn nmcli ENOENT'), unitId: 'u' })
    expect(await gone.status()).toMatchObject({ available: false, mode: 'offline' })
    const down = new NmcliWifi({ run: fakeNmcli([['-t -f GENERAL.STATE', 'GENERAL.STATE:30 (disconnected)\nGENERAL.CONNECTION:\n']]).run, unitId: 'u' })
    expect(await down.status()).toMatchObject({ available: true, mode: 'offline', ssid: null, ip: null })
    const broken = new NmcliWifi({ run: failing('Error: Device wlan0 not found'), unitId: 'u' })
    expect(await broken.status()).toMatchObject({ available: false })
    const odd = new NmcliWifi({ run: failing('Error: NetworkManager is not running'), unitId: 'u' })
    expect(await odd.status()).toMatchObject({ available: true, mode: 'offline', lastError: 'Error: NetworkManager is not running' })
  })

  it('opens an open setup hotspot that closes itself', async () => {
    const t = manual()
    const nm = fakeNmcli([['-t -f GENERAL.STATE', 'GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:seedypod-setup\nIP4.ADDRESS[1]:10.42.0.1/24\n']])
    const w = new NmcliWifi({ run: nm.run, unitId: 'gardyn-ab12', now, ...t })
    const s = await w.startSetup(10)
    expect(nm.calls.map(c => c.join(' '))).toContain('connection add type wifi ifname wlan0 con-name seedypod-setup autoconnect no ssid seedypod-setup-ab12 802-11-wireless.mode ap 802-11-wireless.band bg ipv4.method shared')
    expect(nm.calls.some(c => c.join(' ') === 'connection up seedypod-setup')).toBe(true)
    expect(s).toMatchObject({ mode: 'setup', ssid: 'seedypod-setup-ab12', setup: { ssid: 'seedypod-setup-ab12', url: 'http://10.42.0.1:3000/wifi', until: '2026-10-31T12:10:00.000Z' } })
    expect(t.jobs.map(j => j.ms)).toEqual([600_000])
    t.jobs[0]?.fn()
    await new Promise(r => setTimeout(r, 0))
    expect(nm.calls.some(c => c.join(' ') === 'connection down seedypod-setup')).toBe(true)
    expect(nm.calls.some(c => c.join(' ') === 'device connect wlan0')).toBe(true)
  })

  it('saves the network, replies, then leaves the hotspot and joins it', async () => {
    const t = manual()
    const nm = fakeNmcli([['-t -f GENERAL.STATE', 'GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:seedypod-wifi\n']])
    const w = new NmcliWifi({ run: nm.run, unitId: 'u', now, ...t })
    expect(await w.connect('Home', 'short')).toEqual({ ok: false, detail: 'a WPA password is 8–63 characters' })
    const r = await w.connect('Home', 'correct horse')
    expect(r.ok).toBe(true)
    expect(nm.calls.map(c => c.join(' '))).toContain('connection add type wifi ifname wlan0 con-name seedypod-wifi autoconnect yes ssid Home wifi-sec.key-mgmt wpa-psk wifi-sec.psk correct horse')
    // Nothing switches until after the reply has gone out.
    expect(nm.calls.some(c => c.includes('up') && c.includes('seedypod-wifi'))).toBe(false)
    t.jobs.at(-1)?.fn()
    await w.pending
    expect(nm.calls.map(c => c.join(' ')).slice(-2)).toEqual(['connection down seedypod-setup', '--wait 45 connection up seedypod-wifi'])
    expect((await w.status()).lastError).toBeNull()
    await w.connect('Cafe')
    expect(nm.calls.map(c => c.join(' '))).toContain('connection add type wifi ifname wlan0 con-name seedypod-wifi autoconnect yes ssid Cafe')
  })

  it('brings the hotspot back with the reason when the network can\'t be joined', async () => {
    const t = manual()
    const nm = fakeNmcli([
      ['--wait 45 connection up seedypod-wifi', new Error('Secrets were required, but not provided')],
      ['-t -f GENERAL.STATE', 'GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:seedypod-setup\n'],
    ])
    const w = new NmcliWifi({ run: nm.run, unitId: 'u', now, ...t })
    await w.connect('Home', 'wrong password')
    t.jobs.at(-1)?.fn()
    await w.pending
    expect(nm.calls.at(-2)?.join(' ')).toBe('connection up seedypod-setup')
    expect(await w.status()).toMatchObject({ mode: 'setup', lastError: 'couldn\'t join Home: Secrets were required, but not provided' })
  })

  it('scans without listing its own hotspot', async () => {
    const nm = fakeNmcli([['-t -f IN-USE,SSID', ' :Home:70:WPA2\n*:seedypod-setup-u:100:\n']])
    expect(await new NmcliWifi({ run: nm.run, unitId: 'u' }).scan()).toEqual([{ ssid: 'Home', signal: 70, secure: true, inUse: false }])
  })
})

describe('SimWifi', () => {
  it('walks the same flow in memory', async () => {
    const w = new SimWifi()
    expect((await w.status()).mode).toBe('client')
    expect((await w.startSetup(5)).mode).toBe('setup')
    expect((await w.scan()).every(n => !n.inUse)).toBe(true)
    expect((await w.connect('Garden Shed')).ok).toBe(true)
    expect(await w.status()).toMatchObject({ mode: 'client', ssid: 'Garden Shed' })
    expect((await w.connect('', 'x')).ok).toBe(false)
    expect((await w.stopSetup()).mode).toBe('client')
    expect(await new SimWifi(false).status()).toMatchObject({ available: false })
  })
})
