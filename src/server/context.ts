import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { Store } from '../store/types'
import type { CaptureService } from '../camera/captures'
import type { MirroredSink } from '../camera/mirrorSink'
import type { AnalysisService } from '../vision/service'

export interface Context {
  hal: HalClient
  events: EventBus
  store: Store
  captures: CaptureService
  analysis: AnalysisService
  /** Present when stills go through the opt-in off-device mirror (the unit; not tests or the demo). */
  mirror?: MirroredSink
  /** Build info pinned at release time (.git-info) or 'dev'. */
  version: string
  now?: () => Date
}
