/** Auto light curves take their hours from the tower's grow protocol (ADR-0030), as the protocol card reads it. */
import { AUTO_HOURS } from '../scheduler/lightPlan'
import type { Store } from '../store/types'
import { findProtocol, protocolFor } from './protocol'
import { readTower } from './tower'

export function autoLight(store: Store) {
  const t = readTower(store)
  const protocol = findProtocol(t.cycle?.protocolId) ?? protocolFor(t.planted.map(p => p.plant), t.catalog)
  return { protocolId: protocol.id, protocolName: protocol.name, ...AUTO_HOURS[protocol.id] }
}
