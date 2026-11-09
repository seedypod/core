import type { HalClient } from '../hardware/types'
import type { LightArbiter } from '../control/light'
import type { EventBus } from '../lib/eventBus'
import type { Wifi } from '../network/wifi'
import type { Store } from '../store/types'
import type { AutopilotEngine } from '../autopilot/engine'
import type { CaptureService } from '../camera/captures'
import type { MirroredSink } from '../camera/mirrorSink'
import type { AnalysisService } from '../vision/service'
import type { FlashMeter } from '../telemetry/flash'
import type { BackupService } from '../backup/service'
import type { DatabaseInspector } from '../db/inspect'
import type { RestoreClient } from '../backup/restore'
import type { UpdateClient } from '../update/client'
import type { HomeKitControl } from '../homekit/types'
import type { BridgeStatus } from '../mqtt/bridge'
import type { LoggingControl } from '../logging/policy'

export interface Context {
  hal: HalClient
  events: EventBus
  store: Store
  captures: CaptureService
  analysis: AnalysisService
  wifi: Wifi
  light: LightArbiter
  autopilot: AutopilotEngine
  /** SD card writes (ADR-0021); reports unavailable off a Pi. */
  flash: FlashMeter
  /** The Database view's scan; absent in tests. */
  database?: DatabaseInspector
  /** Present when stills go through the opt-in off-device mirror (the unit; not tests or the demo). */
  mirror?: MirroredSink
  /** Off-card backups (ADR-0021); on the unit only, like the mirror. */
  backup?: BackupService
  /** Runs the root restore helper; on the unit only. */
  restore?: RestoreClient
  /** Runs the root update helper (ADR-0026); on the unit only. */
  update?: UpdateClient
  /** The HomeKit bridge (ADR 0023); node hosts only, off until enabled in Settings. */
  homekit?: HomeKitControl
  /** The Home Assistant MQTT bridge (ADR-0013); node hosts only, where server/index.ts owns it. */
  bridge?: () => BridgeStatus
  /** How much core and hald log; node hosts only, where the policy file lives. */
  logging?: LoggingControl
  /** Build info pinned at release time (.git-info) or 'dev'. */
  version: string
  /** The machine core runs on (the unit's Pi, or a LAN box when the unit has a Pi Zero W); absent in the browser demo. */
  host?: { hostname: string, arch: string }
  now?: () => Date
}
