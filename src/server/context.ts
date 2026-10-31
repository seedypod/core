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
  /** Present when stills go through the opt-in off-device mirror (the unit; not tests or the demo). */
  mirror?: MirroredSink
  /** Build info pinned at release time (.git-info) or 'dev'. */
  version: string
  now?: () => Date
}
