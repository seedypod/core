/**
 * HomeKit lifecycle (ADR 0023): off by default, started when the owner turns
 * it on in Settings, stopped on shutdown. Every start, stop and reset runs one
 * at a time, so a toggle racing a reset can't publish twice on the HAP port.
 *
 * Accessories write through core's tRPC caller, never the HAL directly, so
 * Home's commands take the same path as the app's.
 */
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { Context } from '../server/context'
import { appRouter } from '../server/routers/app'
import { createCallerFactory } from '../server/trpc'
import type { Store } from '../store/types'
import type { HomeKitApi } from './accessories/common'
import type { Advertiser, BridgeOptions, PublishedBridge } from './bridge'
import { HapDebug } from './debug'
import { type Identity, IdentityStore, probeSeeds, type SeedInputs } from './identity'
import type { HomeKitControl, HomeKitSeedProbe, HomeKitStatus } from './types'

export const DEFAULT_PORT = 51827

export interface HomeKitServiceOptions {
  store: Store
  hal: HalClient
  events: EventBus
  /** `$DATA_DIR/homekit`: identity.json and hap-nodejs's pairing files. Resolved against the working directory. */
  dir: string
  /** Where an older core left hap-nodejs's files for a relative `dir`; defaults to `legacyStorageDir(dir)`. */
  legacyDir?: string | null
  version: string
  env?: NodeJS.ProcessEnv
  /** Seed-chain file reads; tests point these away from /proc. */
  readFile?: SeedInputs['readFile']
  /** The hap-nodejs side; loaded on first start. */
  loadBridge?: () => Promise<{ publishBridge(o: BridgeOptions): Promise<PublishedBridge>, hapName(name: string): string }>
  renderQr?: (uri: string) => Promise<string>
  /** How long a first start waits for hald to report its unit id (the preferred seed). */
  systemWaitMs?: number
  log?: (msg: string) => void
}

/** `HOMEKIT_ADVERTISER` picks the mDNS responder; ciao unless it names another hap-nodejs knows. */
export function pickAdvertiser(env: NodeJS.ProcessEnv): Advertiser {
  const want = env.HOMEKIT_ADVERTISER
  return want === 'avahi' || want === 'bonjour-hap' || want === 'resolved' ? want : 'ciao'
}

export function pickBind(env: NodeJS.ProcessEnv): string[] | undefined {
  const list = (env.HOMEKIT_BIND ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? list : undefined
}

export function pickPort(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOMEKIT_PORT)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

/**
 * hap-nodejs's node-persist resolves a relative storage path against its own
 * package (`node-persist/src/storage/<dir>`), not the working directory, so a
 * core started with a relative DATA_DIR kept its pairings inside node_modules.
 * Null for an absolute `dir`, or when the package can't be found.
 */
export function legacyStorageDir(dir: string, resolveFrom: (spec: string, from: string) => string = (spec, from) => createRequire(from).resolve(spec)): string | null {
  if (isAbsolute(dir)) return null
  try {
    const persist = resolveFrom('node-persist', resolveFrom('hap-nodejs', import.meta.url))
    return join(dirname(persist), 'storage', normalize(dir))
  }
  catch {
    return null
  }
}

async function svgQr(uri: string): Promise<string> {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'Q', margin: 1 })
}

export class HomeKitService implements HomeKitControl {
  readonly ids: IdentityStore
  private readonly dir: string
  private readonly legacyDir: string | null
  private ctx: Context | null = null
  private published: PublishedBridge | null = null
  private identity: Identity | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private transitioning = false
  private error: string | null = null
  private qr: { uri: string, svg: string } | null = null
  private readonly env: NodeJS.ProcessEnv
  private readonly log: (msg: string) => void
  private readonly seed: SeedInputs
  private rotateTimer: ReturnType<typeof setTimeout> | null = null
  private readonly hapDebug: HapDebug

  constructor(private readonly o: HomeKitServiceOptions) {
    this.env = o.env ?? process.env
    this.log = o.log ?? (m => console.warn(m))
    this.seed = { system: () => o.hal.snapshot().system, readFile: o.readFile }
    // Absolute, so core reads the pairings where hap-nodejs writes them.
    this.dir = resolve(o.dir)
    this.legacyDir = o.legacyDir === undefined ? legacyStorageDir(o.dir) : o.legacyDir
    this.ids = new IdentityStore(this.dir, this.seed, this.log)
    this.hapDebug = new HapDebug({ log: this.log })
  }

  /** Called by createCore once the context exists; the accessories write through its caller. */
  attach(ctx: Context): void {
    this.ctx = ctx
  }

  async status(): Promise<HomeKitStatus> {
    const identity = this.identity ?? this.ids.read()
    const setupURI = this.published?.setupURI ?? null
    return {
      enabled: this.o.store.settings.get().homekitEnabled,
      running: this.published !== null,
      transitioning: this.transitioning,
      setupCode: identity?.pincode ?? null,
      setupURI,
      qrSvg: setupURI ? await this.qrFor(setupURI) : null,
      pairedControllers: identity ? this.ids.pairedControllers(identity.username).length : 0,
      error: this.error,
    }
  }

  setEnabled(enabled: boolean): Promise<HomeKitStatus> {
    return this.transition(async () => {
      if (enabled) await this.start()
      else await this.stopBridge()
      this.o.store.settings.update({ homekitEnabled: enabled })
    })
  }

  resetPairing(): Promise<HomeKitStatus> {
    return this.transition(() => this.rotate('reset from Settings'))
  }

  seedProbe(): HomeKitSeedProbe {
    const { resolved, sources } = probeSeeds(this.seed)
    const id = this.ids.read()
    return { resolved, sources, identity: id ? { derivedFrom: id.derivedFrom, rotation: id.rotation, derivedAt: id.derivedAt } : null }
  }

  debug(minutes: number): { until: string | null } {
    return this.hapDebug.set(minutes)
  }

  /** Boot: start the bridge if the owner left HomeKit on. A failure is logged and shown in Settings. */
  startIfEnabled(): Promise<void> {
    if (!this.o.store.settings.get().homekitEnabled) return Promise.resolve()
    return this.serialize(() => this.start()).catch((e: Error) => this.log(`homekit: not started: ${e.message}`))
  }

  /** Process shutdown: unpublish, keeping pairings and the saved switch. */
  shutdown(): Promise<void> {
    if (this.rotateTimer) clearTimeout(this.rotateTimer)
    this.hapDebug.off('core stopping')
    return this.serialize(() => this.stopBridge())
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async transition(fn: () => Promise<void>): Promise<HomeKitStatus> {
    await this.serialize(async () => {
      this.transitioning = true
      try {
        await fn()
      }
      finally {
        this.transitioning = false
        this.o.events.emit({ kind: 'mutation', path: 'homekit' })
      }
    })
    return this.status()
  }

  private async start(): Promise<void> {
    if (this.published) return
    const ctx = this.ctx
    if (!ctx) throw new Error('HomeKit is not attached to core')
    try {
      if (!this.ids.read()) await this.waitForSystem()
      let identity = this.ids.loadOrCreate()
      if (this.legacyDir && this.ids.adoptPairings(this.legacyDir, identity.username)) {
        this.log(`homekit: moved ${identity.username}'s pairings from ${this.legacyDir}`)
      }
      if (this.ids.isStranded(identity)) {
        this.log(`homekit: ${identity.username} was removed from Home while core was down; rotating its identity`)
        this.ids.clearPairings(identity.username)
        identity = this.ids.rotate()
      }
      else if (!identity.wasPaired && this.ids.pairedControllers(identity.username).length > 0) {
        this.ids.markPaired()
        identity = { ...identity, wasPaired: true }
      }
      this.identity = identity
      const bridge = await (this.o.loadBridge ?? (() => import('./bridge')))()
      const port = pickPort(this.env)
      const advertiser = pickAdvertiser(this.env)
      this.published = await bridge.publishBridge({
        identity,
        dir: this.dir,
        deps: { api: createCallerFactory(appRouter)(ctx) satisfies HomeKitApi, hal: this.o.hal, events: this.o.events, stills: ctx.captures, log: this.log },
        name: bridge.hapName(this.o.store.settings.get().unitName),
        port,
        advertiser,
        bind: pickBind(this.env),
        version: this.o.version,
        onPaired: () => this.onPaired(),
        onUnpaired: () => this.onUnpaired(),
      })
      this.error = null
      // Never the setup code or setup id (ADR 0023).
      this.log(`homekit: bridge ${identity.username} (${identity.derivedFrom}) on port ${port} via ${advertiser}, ${this.ids.pairedControllers(identity.username).length} paired`)
    }
    catch (e) {
      this.error = (e as Error).message
      throw e
    }
  }

  private async stopBridge(): Promise<void> {
    const b = this.published
    if (!b) return
    await b.unpublish()
    this.published = null
  }

  /** New username, code and setup id; the old pairing files go first so none is left behind. */
  private async rotate(reason: string): Promise<void> {
    const old = this.identity ?? this.ids.read()
    await this.stopBridge()
    if (old) this.ids.clearPairings(old.username)
    this.identity = this.ids.rotate()
    this.log(`homekit: identity rotated to ${this.identity.username} (${reason})`)
    if (this.o.store.settings.get().homekitEnabled) await this.start()
  }

  private onPaired(): void {
    this.ids.markPaired()
    if (this.identity) this.identity = { ...this.identity, wasPaired: true }
    this.o.events.emit({ kind: 'mutation', path: 'homekit' })
  }

  /**
   * The last controller removed the bridge from Home. Rotate now rather than at
   * the next start, so the code in Settings pairs straight away instead of
   * meeting iOS's cached keys for the old username.
   */
  private onUnpaired(): void {
    this.o.events.emit({ kind: 'mutation', path: 'homekit' })
    if (this.rotateTimer) clearTimeout(this.rotateTimer)
    // Let hap-nodejs finish answering the removal before the server goes away.
    this.rotateTimer = setTimeout(() => {
      this.rotateTimer = null
      void this.transition(async () => {
        const cur = this.identity
        if (this.published && cur && this.ids.isStranded(cur)) await this.rotate('removed from Home')
      }).catch((e: Error) => this.log(`homekit: rotation after removal failed: ${e.message}`))
    }, 1000)
    this.rotateTimer.unref?.()
  }

  /** The preferred seed is hald's unit id; on a first start give hald a moment to report it. */
  private waitForSystem(): Promise<void> {
    if (this.o.hal.snapshot().system) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.o.systemWaitMs ?? 10_000)
      const unsubscribe = this.o.hal.subscribe((e) => {
        if (e.type === 'system') done()
      })
      function done() {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  }

  private async qrFor(uri: string): Promise<string> {
    if (this.qr?.uri !== uri) this.qr = { uri, svg: await (this.o.renderQr ?? svgQr)(uri) }
    return this.qr.svg
  }
}
