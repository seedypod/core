/**
 * Bonjour advertisement for core (ADR-0017): `_seedypod._tcp` on the HTTP port,
 * so the iOS app finds the unit with NWBrowser instead of a typed-in address.
 * TXT `id` is the unit, `v` core's version, `auth` whether off-host requests
 * need the API key. TXT follows the API key setting and hald's unit id live.
 *
 * Uses ciao, the responder hap-nodejs already ships, loaded only when it
 * starts. A failure is logged and core carries on without it.
 */
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { Store } from '../store/types'

/** ciao prefixes the underscore and appends `._tcp`. */
export const SERVICE_TYPE = 'seedypod'

export interface CoreTxt {
  id: string
  v: string
  auth: '0' | '1'
}

export interface Advertisement {
  updateTxt(txt: CoreTxt): void
  end(): Promise<void>
}

export interface AdvertiseOptions {
  name: string
  hostname: string
  port: number
  txt: CoreTxt
}

/** The slice of @homebridge/ciao used here. */
export interface CiaoLike {
  getResponder(): {
    createService(o: { name: string, type: string, port: number, hostname: string, txt: CoreTxt }): {
      advertise(): Promise<void>
      updateTxt(txt: CoreTxt): void
      destroy(): Promise<void>
    }
    shutdown(): Promise<void>
  }
}

export type Advertise = (o: AdvertiseOptions) => Promise<Advertisement>

/** Off with `SEEDYPOD_MDNS=0`, under Vitest, and when core listens only on loopback. */
export function mdnsEnabled(env: NodeJS.ProcessEnv, host: string): boolean {
  const flag = (env.SEEDYPOD_MDNS ?? '').trim().toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'off') return false
  if (env.VITEST || env.NODE_ENV === 'test') return false
  return !(host === 'localhost' || host === '::1' || host.startsWith('127.'))
}

export function coreTxt(o: { store: Store, hal: HalClient, version: string, env: NodeJS.ProcessEnv, hostname: string }): CoreTxt {
  return {
    id: o.hal.snapshot().system?.unitId ?? o.env.HAL_UNIT_ID ?? o.hostname,
    v: o.version,
    auth: o.store.settings.get().apiKey ? '1' : '0',
  }
}

/** One DNS label: lowercase letters, digits and dashes, at most 63 octets. */
export function hostLabel(id: string): string {
  const slug = id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58).replace(/-+$/, '')
  return `${slug || 'seedypod'}-core`
}

export function ciaoAdvertise(load: () => Promise<CiaoLike> = async () => (await import('@homebridge/ciao')).default as unknown as CiaoLike): Advertise {
  return async (o) => {
    const responder = (await load()).getResponder()
    const service = responder.createService({ name: o.name, type: SERVICE_TYPE, port: o.port, hostname: o.hostname, txt: o.txt })
    try {
      await service.advertise()
    }
    catch (e) {
      await service.destroy().catch(() => undefined)
      await responder.shutdown().catch(() => undefined)
      throw e
    }
    return {
      updateTxt: txt => service.updateTxt(txt),
      end: async () => {
        await service.destroy()
        await responder.shutdown()
      },
    }
  }
}

export interface CoreAdvertiserOptions {
  store: Store
  hal: HalClient
  events: EventBus
  version: string
  port: number
  /** The address core binds; loopback means nothing to advertise. */
  host: string
  hostname: string
  env?: NodeJS.ProcessEnv
  advertise?: Advertise
  log?: (msg: string) => void
}

export class CoreAdvertiser {
  private live: { ad: Advertisement, txt: CoreTxt } | null = null
  private unsubscribe: (() => void) | null = null
  private stopped = false
  private readonly env: NodeJS.ProcessEnv
  private readonly log: (msg: string) => void

  constructor(private readonly o: CoreAdvertiserOptions) {
    this.env = o.env ?? process.env
    this.log = o.log ?? (m => console.warn(m))
  }

  /** Never rejects: mDNS is a convenience, not a dependency. */
  async start(): Promise<void> {
    if (this.live || !mdnsEnabled(this.env, this.o.host)) return
    const txt = this.current()
    try {
      const ad = await (this.o.advertise ?? ciaoAdvertise())({
        name: this.o.store.settings.get().unitName.trim() || 'seedypod',
        hostname: hostLabel(txt.id),
        port: this.o.port,
        txt,
      })
      if (this.stopped) {
        await ad.end().catch(() => undefined)
        return
      }
      const live = { ad, txt }
      this.live = live
      this.unsubscribe = this.o.events.subscribe((e) => {
        if ((e.kind === 'mutation' && e.path === 'settings') || (e.kind === 'hal' && e.event.type === 'system')) this.refresh(live)
      })
      this.log(`mdns: advertising _${SERVICE_TYPE}._tcp on port ${this.o.port} (id=${txt.id} v=${txt.v} auth=${txt.auth})`)
    }
    catch (e) {
      this.log(`mdns: not advertising: ${(e as Error).message}`)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    const live = this.live
    this.live = null
    if (!live) return
    await live.ad.end().catch((e: Error) => this.log(`mdns: goodbye failed: ${e.message}`))
  }

  private current(): CoreTxt {
    return coreTxt({ store: this.o.store, hal: this.o.hal, version: this.o.version, env: this.env, hostname: this.o.hostname })
  }

  private refresh(live: { ad: Advertisement, txt: CoreTxt }): void {
    const next = this.current()
    if (live.txt.id === next.id && live.txt.auth === next.auth) return
    try {
      live.ad.updateTxt(next)
      live.txt = next
    }
    catch (e) {
      this.log(`mdns: TXT update failed: ${(e as Error).message}`)
    }
  }
}
