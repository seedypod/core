import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { Wifi } from '../network/wifi'
import type { Store } from '../store/types'
import type { CaptureService } from '../camera/captures'

export interface Context {
  hal: HalClient
  events: EventBus
  store: Store
  captures: CaptureService
  wifi: Wifi
  /** Build info pinned at release time (.git-info) or 'dev'. */
  version: string
  now?: () => Date
}
