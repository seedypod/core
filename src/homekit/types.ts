/**
 * What the HomeKit router sees of the bridge. Types only, so the router (and
 * the browser demo that runs it in-page) never pulls in hap-nodejs.
 */
import type { SeedProbeEntry, SeedSource } from './identity'

export interface HomeKitStatus {
  enabled: boolean
  running: boolean
  /** A start, stop or reset is in flight; `running` may be about to change. */
  transitioning: boolean
  /** `XXX-XX-XXX`; null until the bridge has an identity. */
  setupCode: string | null
  /** `X-HM://…` for the QR; null unless the bridge is running. */
  setupURI: string | null
  /** The QR as an SVG document; null with no setup URI. */
  qrSvg: string | null
  pairedControllers: number
  /** The last start failure, cleared on the next successful start. */
  error: string | null
}

export interface HomeKitSeedProbe {
  resolved: SeedSource
  sources: SeedProbeEntry[]
  identity: { derivedFrom: SeedSource, rotation: number, derivedAt: number } | null
}

export interface HomeKitControl {
  status(): Promise<HomeKitStatus>
  /** Starts or stops the bridge, then saves the switch; a failed start leaves it off. */
  setEnabled(enabled: boolean): Promise<HomeKitStatus>
  /** Removes every pairing and rotates the identity (new code and QR); restarts if enabled. */
  resetPairing(): Promise<HomeKitStatus>
  seedProbe(): HomeKitSeedProbe
}
