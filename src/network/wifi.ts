/**
 * Wi-Fi setup without a keyboard (Garden of Eden roadmap #36). Holding the
 * button for 10 s makes hald report a `setup` press; core then opens an open
 * hotspot for a few minutes, the owner joins it, picks their network on the
 * Wi-Fi screen, and core hands the radio back to that network. Physical access
 * to the button is the authentication, as on most appliances.
 *
 * Raspberry Pi OS (Bookworm) manages networking with NetworkManager, so this
 * drives `nmcli`; the installer grants the core service user that permission.
 */

export interface WifiNetwork { ssid: string, signal: number, secure: boolean, inUse: boolean }

export interface WifiStatus {
  /** False where there is no NetworkManager (a laptop, CI, the demo). */
  available: boolean
  mode: 'client' | 'setup' | 'offline'
  ssid: string | null
  ip: string | null
  /** The open setup hotspot while it is up. */
  setup: { ssid: string, url: string, until: string } | null
  /** Why the last connect attempt failed, shown when the owner rejoins the hotspot. */
  lastError: string | null
}

export interface Wifi {
  status(): Promise<WifiStatus>
  scan(): Promise<WifiNetwork[]>
  startSetup(minutes?: number): Promise<WifiStatus>
  stopSetup(): Promise<WifiStatus>
  /** Saves the network and switches to it shortly after replying, so the reply still reaches a phone on the hotspot. */
  connect(ssid: string, password?: string): Promise<{ ok: boolean, detail: string }>
}

export type Run = (args: string[]) => Promise<string>

const SETUP_CON = 'seedypod-setup'
const WIFI_CON = 'seedypod-wifi'
/** NetworkManager's address for the host side of a shared connection. */
const SETUP_URL = 'http://10.42.0.1:3000/wifi'

export function validateCredentials(ssid: string, password?: string): string | null {
  const bytes = new TextEncoder().encode(ssid).length
  if (bytes < 1 || bytes > 32) return 'the network name must be 1–32 bytes'
  if (password && (password.length < 8 || password.length > 63)) return 'a WPA password is 8–63 characters'
  return null
}

/** Split one `nmcli -t` line on unescaped colons. */
export function splitTerse(line: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
    }
    else if (c === ':') {
      out.push(cur)
      cur = ''
    }
    else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

export function parseScan(text: string): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [inUse = '', ssid = '', signal = '0', security = ''] = splitTerse(line)
    if (!ssid) continue
    const n: WifiNetwork = { ssid, signal: Number(signal) || 0, secure: security !== '' && security !== '--', inUse: inUse === '*' }
    const prev = best.get(ssid)
    const strongest = !prev || n.signal > prev.signal ? n : prev
    best.set(ssid, { ...strongest, inUse: n.inUse || !!prev?.inUse })
  }
  return [...best.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal)
}

export interface NmcliOptions {
  run: Run
  unitId: string
  ifname?: string
  now?: () => Date
  /** Delay before switching networks after `connect` replies. */
  switchDelayMs?: number
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export class NmcliWifi implements Wifi {
  private readonly ifname: string
  private setupUntil: Date | null = null
  private setupTimer: unknown = null
  private lastError: string | null = null
  /** The background switch started by `connect`, for tests. */
  pending: Promise<void> = Promise.resolve()

  constructor(private readonly o: NmcliOptions) {
    this.ifname = o.ifname ?? 'wlan0'
  }

  get setupSsid(): string {
    return `seedypod-setup-${this.o.unitId.replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase() || 'unit'}`
  }

  private now(): Date {
    return this.o.now?.() ?? new Date()
  }

  private schedule(fn: () => void, ms: number): unknown {
    return (this.o.schedule ?? ((f, t) => setTimeout(f, t)))(fn, ms)
  }

  private clearSetupTimer(): void {
    if (this.setupTimer) (this.o.cancel ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.setupTimer)
    this.setupTimer = null
    this.setupUntil = null
  }

  async status(): Promise<WifiStatus> {
    let dev: string
    try {
      dev = await this.o.run(['-t', '-f', 'GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS', 'device', 'show', this.ifname])
    }
    catch (e) {
      const missing = /ENOENT|not found/i.test((e as Error).message)
      return { available: !missing, mode: 'offline', ssid: null, ip: null, setup: null, lastError: missing ? null : (e as Error).message }
    }
    const field = (k: string) => dev.split('\n').find(l => l.startsWith(`${k}:`) || l.startsWith(`${k}[1]:`))?.replace(/^[^:]+:/, '') ?? ''
    const connection = field('GENERAL.CONNECTION')
    const ip = field('IP4.ADDRESS').split('/')[0] || null
    const connected = /\b100\b/.test(field('GENERAL.STATE'))
    if (connection === SETUP_CON) {
      return { available: true, mode: 'setup', ssid: this.setupSsid, ip, setup: { ssid: this.setupSsid, url: SETUP_URL, until: (this.setupUntil ?? this.now()).toISOString() }, lastError: this.lastError }
    }
    let ssid: string | null = null
    if (connected) {
      const active = await this.o.run(['-t', '-f', 'ACTIVE,SSID', 'device', 'wifi', 'list', 'ifname', this.ifname, '--rescan', 'no']).catch(() => '')
      ssid = active.split('\n').map(splitTerse).find(([a]) => a === 'yes')?.[1] ?? (connection || null)
    }
    return { available: true, mode: connected ? 'client' : 'offline', ssid, ip: connected ? ip : null, setup: null, lastError: this.lastError }
  }

  async scan(): Promise<WifiNetwork[]> {
    const text = await this.o.run(['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', 'ifname', this.ifname, '--rescan', 'auto'])
    return parseScan(text).filter(n => n.ssid !== this.setupSsid)
  }

  async startSetup(minutes = 15): Promise<WifiStatus> {
    await this.o.run(['connection', 'delete', SETUP_CON]).catch(() => '')
    await this.o.run(['connection', 'add', 'type', 'wifi', 'ifname', this.ifname, 'con-name', SETUP_CON, 'autoconnect', 'no', 'ssid', this.setupSsid,
      '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg', 'ipv4.method', 'shared'])
    await this.o.run(['connection', 'up', SETUP_CON])
    this.clearSetupTimer()
    this.setupUntil = new Date(this.now().getTime() + minutes * 60_000)
    // Never leave an open hotspot up: it closes on its own and the unit rejoins its saved network.
    this.setupTimer = this.schedule(() => void this.stopSetup().catch(() => undefined), minutes * 60_000)
    return this.status()
  }

  async stopSetup(): Promise<WifiStatus> {
    this.clearSetupTimer()
    await this.o.run(['connection', 'down', SETUP_CON]).catch(() => '')
    await this.o.run(['device', 'connect', this.ifname]).catch(() => '')
    return this.status()
  }

  async connect(ssid: string, password?: string): Promise<{ ok: boolean, detail: string }> {
    const bad = validateCredentials(ssid, password)
    if (bad) return { ok: false, detail: bad }
    await this.o.run(['connection', 'delete', WIFI_CON]).catch(() => '')
    await this.o.run(['connection', 'add', 'type', 'wifi', 'ifname', this.ifname, 'con-name', WIFI_CON, 'autoconnect', 'yes', 'ssid', ssid,
      ...(password ? ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password] : [])])
    this.lastError = null
    this.pending = new Promise<void>((resolve) => {
      this.schedule(() => {
        void (async () => {
          this.clearSetupTimer()
          await this.o.run(['connection', 'down', SETUP_CON]).catch(() => '')
          try {
            await this.o.run(['--wait', '45', 'connection', 'up', WIFI_CON])
          }
          catch (e) {
            // Couldn't join: bring the hotspot back so the owner can see why and try again.
            this.lastError = `couldn't join ${ssid}: ${(e as Error).message}`
            await this.startSetup().catch(() => undefined)
          }
          resolve()
        })()
      }, this.o.switchDelayMs ?? 2000)
    })
    return { ok: true, detail: `saved ${ssid}; switching in a moment. Rejoin your network and open http://seedypod.local:3000` }
  }
}

/** In-memory Wi-Fi for tests and the browser demo. */
export class SimWifi implements Wifi {
  private mode: WifiStatus['mode'] = 'client'
  private ssid: string | null = 'Home'
  private until: string | null = null
  networks: WifiNetwork[] = [
    { ssid: 'Home', signal: 78, secure: true, inUse: true },
    { ssid: 'Home-5G', signal: 64, secure: true, inUse: false },
    { ssid: 'Garden Shed', signal: 31, secure: false, inUse: false },
  ]

  constructor(private readonly available = true) {}

  async status(): Promise<WifiStatus> {
    if (!this.available) return { available: false, mode: 'offline', ssid: null, ip: null, setup: null, lastError: null }
    const setup = this.mode === 'setup' ? { ssid: 'seedypod-setup-demo', url: SETUP_URL, until: this.until ?? new Date().toISOString() } : null
    return { available: true, mode: this.mode, ssid: this.mode === 'setup' ? setup?.ssid ?? null : this.ssid, ip: this.mode === 'client' ? '192.168.1.40' : '10.42.0.1', setup, lastError: null }
  }

  async scan(): Promise<WifiNetwork[]> {
    return this.networks.map(n => ({ ...n, inUse: n.ssid === this.ssid && this.mode === 'client' }))
  }

  async startSetup(minutes = 15): Promise<WifiStatus> {
    this.mode = 'setup'
    this.until = new Date(Date.now() + minutes * 60_000).toISOString()
    return this.status()
  }

  async stopSetup(): Promise<WifiStatus> {
    this.mode = 'client'
    this.until = null
    return this.status()
  }

  async connect(ssid: string, password?: string): Promise<{ ok: boolean, detail: string }> {
    const bad = validateCredentials(ssid, password)
    if (bad) return { ok: false, detail: bad }
    this.ssid = ssid
    this.mode = 'client'
    return { ok: true, detail: `saved ${ssid}; switching in a moment. Rejoin your network and open http://seedypod.local:3000` }
  }
}
