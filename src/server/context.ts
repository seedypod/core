import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'

export interface Context {
  hal: HalClient
  events: EventBus
  /** Build info pinned at release time (.git-info) or 'dev'. */
  version: string
}

export function createContextFactory(base: Context) {
  return (): Context => base
}
