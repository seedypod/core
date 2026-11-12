/**
 * HomeKit identity and pairing files (ADR 0023, porting sleepypod ADR 0020).
 *
 * HAP keys everything iOS does with the bridge on three values: the MAC-style
 * `username`, the 8-digit setup code and the 4-character setup id. They are
 * derived with HKDF from a per-unit seed, so a reinstall or a new SD card on
 * the same unit comes back with the same values and the user only re-pairs;
 * `identity.json` caches them so the seed is read once. Pairings themselves
 * (`AccessoryInfo.<MAC>.json`, written by hap-nodejs) are not derivable.
 *
 * Node-only. Nothing here logs the setup code or setup id.
 */
import { hkdfSync, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SystemInfo } from '../hardware/contract'

// Bumping this changes every unit's identity the next time identity.json is
// missing. It is the escape hatch if a derivation bug ships.
const HKDF_SALT = 'seedypod-homekit-v1'

const IDENTITY_FILE = 'identity.json'

/** Setup codes HAP rejects outright. */
const REJECTED_PINCODES = new Set([
  '00000000', '11111111', '22222222', '33333333', '44444444',
  '55555555', '66666666', '77777777', '88888888', '99999999',
  '12345678', '87654321',
])

const SETUPID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

export type SeedSource = 'hal-unit-id' | 'pi-serial' | 'machine-id' | 'random'

export interface Identity {
  /** `AA:BB:CC:DD:EE:FF`, locally administered. */
  username: string
  /** `XXX-XX-XXX` */
  pincode: string
  setupId: string
  derivedFrom: SeedSource
  derivedAt: number
  rotation: number
  /** Set once a controller has paired with this identity; see `isStranded`. */
  wasPaired?: boolean
}

export interface SeedProbeEntry {
  source: SeedSource
  present: boolean
  usable: boolean
}

/** Where the seed chain reads from. Injected so tests never touch /proc. */
export interface SeedInputs {
  /** What hald reports in `system`; null when it hasn't reported yet. */
  system: () => SystemInfo | null
  readFile?: (path: string) => string
}

const readText = (path: string) => readFileSync(path, 'utf8')

function degenerate(v: string): boolean {
  return !v || /^0+$/.test(v) || /^f+$/i.test(v)
}

/**
 * The unit id hald reports, when it names real hardware. `gardyn-unknown`
 * (no Pi serial) and the simulators' fixed ids would give every such core the
 * same HomeKit identity, so they don't count.
 */
export function usableUnitId(system: SystemInfo | null): string | null {
  if (!system) return null
  const id = system.unitId.trim()
  if (!id || id === 'gardyn-unknown') return null
  if (/\bsim\b/i.test(system.model) || /sim/i.test(system.halVersion)) return null
  return id
}

/**
 * The Pi's serial from /proc/cpuinfo, written the way hald writes its default
 * unit id (`hal/crates/hald/src/identity.rs`): core on the unit's own Pi then
 * derives the same seed whether or not hald had reported yet.
 */
export function piSerialUnitId(cpuinfo: string): string | null {
  const line = cpuinfo.split('\n').find(l => l.startsWith('Serial'))
  const serial = line?.split(':')[1]?.trim().replace(/^0+/, '') ?? ''
  return degenerate(serial) ? null : `gardyn-${serial}`
}

function tryRead(read: (p: string) => string, path: string): { present: boolean, value: string | null } {
  try {
    return { present: true, value: read(path).trim() }
  }
  catch {
    return { present: false, value: null }
  }
}

/** Walks the seed chain, most stable first; ADR 0023 has the reasoning for each. */
export function probeSeeds(inputs: SeedInputs): { resolved: SeedSource, value: string, sources: SeedProbeEntry[] } {
  const read = inputs.readFile ?? readText
  const system = inputs.system()
  const halId = usableUnitId(system)
  const cpu = tryRead(read, '/proc/cpuinfo')
  const piId = cpu.value === null ? null : piSerialUnitId(cpu.value)
  const machine = tryRead(read, '/etc/machine-id')
  const machineId = machine.value !== null && !degenerate(machine.value) ? machine.value : null
  const chain: Array<{ source: SeedSource, present: boolean, value: string | null }> = [
    { source: 'hal-unit-id', present: system !== null, value: halId },
    { source: 'pi-serial', present: cpu.present, value: piId },
    { source: 'machine-id', present: machine.present, value: machineId },
  ]
  const hit = chain.find(c => c.value !== null)
  const sources = [...chain.map(c => ({ source: c.source, present: c.present, usable: c.value !== null })), { source: 'random' as const, present: true, usable: true }]
  if (hit?.value) return { resolved: hit.source, value: hit.value, sources }
  return { resolved: 'random', value: randomBytes(32).toString('hex'), sources }
}

function derive(seed: string, label: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', seed, HKDF_SALT, label, length))
}

export function deriveUsername(seed: string, rotation: number): string {
  const bytes = derive(seed, `username/${rotation}`, 6)
  // Locally administered, unicast: HAP wants it to look like a MAC no vendor owns.
  bytes[0] = ((bytes[0] as number) & 0xFE) | 0x02
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

export function derivePincode(seed: string, rotation: number, attempts = 32): string {
  // HAP's banned set is tiny, so this returns on the first try for any real seed.
  // The budget turns a pathological derivation into an error, not a hang.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const n = derive(seed, `pincode/${rotation}/${attempt}`, 4).readUInt32BE(0) % 100_000_000
    const digits = n.toString().padStart(8, '0')
    if (!REJECTED_PINCODES.has(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
  }
  throw new Error('homekit setup code derivation ran out of attempts')
}

export function deriveSetupId(seed: string, rotation: number): string {
  return Array.from(derive(seed, `setupid/${rotation}`, 4), b => SETUPID_ALPHABET[b % SETUPID_ALPHABET.length]).join('')
}

export function deriveIdentity(seed: { resolved: SeedSource, value: string }, rotation: number, now = Date.now()): Identity {
  return {
    username: deriveUsername(seed.value, rotation),
    pincode: derivePincode(seed.value, rotation),
    setupId: deriveSetupId(seed.value, rotation),
    derivedFrom: seed.resolved,
    derivedAt: Math.floor(now / 1000),
    rotation,
  }
}

/** identity.json, the pairing files hap-nodejs writes, and the operations on them. */
export class IdentityStore {
  constructor(readonly dir: string, private readonly inputs: SeedInputs, private readonly log: (msg: string) => void = m => console.warn(m)) {}

  private get file(): string {
    return join(this.dir, IDENTITY_FILE)
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  private write(identity: Identity): void {
    this.ensureDir()
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** identity.json without creating it; null when absent or unreadable. */
  read(): Identity | null {
    if (!existsSync(this.file)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Identity>
      if (parsed.username && parsed.pincode && parsed.setupId) return parsed as Identity
    }
    catch { /* treated as absent */ }
    return null
  }

  loadOrCreate(): Identity {
    const cached = this.read()
    if (cached) return cached
    if (existsSync(this.file)) {
      // Keep a corrupt file for diagnosis instead of overwriting it.
      const backup = `${this.file}.corrupt.${Date.now()}`
      try {
        renameSync(this.file, backup)
        this.log(`homekit: identity.json unreadable, kept as ${backup}`)
      }
      catch { /* regenerate anyway */ }
    }
    const identity = deriveIdentity(probeSeeds(this.inputs), 0)
    this.write(identity)
    this.log(`homekit: derived identity ${identity.username} from ${identity.derivedFrom}`)
    return identity
  }

  /** A fresh username, code and setup id from the same seed: bumps the rotation counter. */
  rotate(): Identity {
    const prev = this.read()
    const identity = deriveIdentity(probeSeeds(this.inputs), (prev?.rotation ?? -1) + 1)
    this.write(identity)
    return identity
  }

  /** Records that this identity has been paired; written once. */
  markPaired(): void {
    const cur = this.read()
    if (!cur || cur.wasPaired) return
    this.write({ ...cur, wasPaired: true })
  }

  private key(username: string): string {
    return username.replace(/:/g, '').toUpperCase()
  }

  /** Controller ids hap-nodejs persisted for this identity. */
  pairedControllers(username: string): string[] {
    const file = join(this.dir, `AccessoryInfo.${this.key(username)}.json`)
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pairedClients?: Record<string, unknown> }
      return Object.keys(parsed.pairedClients ?? {})
    }
    catch {
      return []
    }
  }

  private hapFiles(username: string): string[] {
    const key = this.key(username)
    return [`AccessoryInfo.${key}.json`, `IdentifierCache.${key}.json`, `ControllerStorage.${key}.json`]
  }

  /** Removes hap-nodejs's pairing state for `username` (its long-term keys, pairings and accessory ids). */
  clearPairings(username: string): void {
    for (const name of this.hapFiles(username)) rmSync(join(this.dir, name), { force: true })
  }

  /**
   * Moves hap-nodejs's files for `username` here from `from`, unless this
   * directory already has its own. Returns whether anything moved.
   */
  adoptPairings(from: string, username: string): boolean {
    const info = `AccessoryInfo.${this.key(username)}.json`
    if (existsSync(join(this.dir, info)) || !existsSync(join(from, info))) return false
    this.ensureDir()
    for (const name of this.hapFiles(username)) {
      const src = join(from, name)
      if (!existsSync(src)) continue
      copyFileSync(src, join(this.dir, name))
      rmSync(src, { force: true })
    }
    return true
  }

  /**
   * Paired once, no pairings now: iOS removed the bridge from Home, which goes
   * straight to the HAP server. Republishing the same username strands iOS on
   * its old pair-verify keys ("No Response", re-pair refused), so the caller
   * rotates first (sleepypod PR #578).
   */
  isStranded(identity: Identity): boolean {
    return identity.wasPaired === true && this.pairedControllers(identity.username).length === 0
  }
}
