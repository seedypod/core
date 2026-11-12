/** Auto light curves take their hours from the tower's grow protocol (ADR-0030), as the protocol card reads it. */
import { AUTO_HOURS } from '../scheduler/lightPlan'
import { AUTO_SUN, followSun } from '../scheduler/sun'
import type { Schedule, Store } from '../store/types'
import { findProtocol, protocolFor } from './protocol'
import { readTower } from './tower'

export function autoLight(store: Store) {
  const t = readTower(store)
  const protocol = findProtocol(t.cycle?.protocolId) ?? protocolFor(t.planted.map(p => p.plant), t.catalog)
  return { protocolId: protocol.id, protocolName: protocol.name, ...AUTO_HOURS[protocol.id] }
}

const isAuto = (s: Schedule) => s.kind === 'light' && 'setpoints' in s.spec && !!s.spec.sun?.auto

/**
 * Auto on: its curve runs alone, made if there isn't one, and the curves it
 * switched off are kept to turn back on. Auto off: its curve stops and those
 * curves come back. Returns the curves changed.
 */
export function setAuto(store: Store, on: boolean, now: Date): string[] {
  const all = store.schedules.list()
  const changed: string[] = []
  const save = (s: Schedule, enabled: boolean, spec = s.spec) => {
    store.schedules.upsert({ id: s.id, kind: s.kind, name: s.name, enabled, days: s.days, spec })
    changed.push(s.id)
  }
  if (on) {
    const others = all.filter(s => s.kind === 'light' && s.enabled && !isAuto(s))
    for (const s of others) save(s, false)
    const auto = all.find(isAuto)
    const spec = followSun(auto && 'setpoints' in auto.spec ? auto.spec : { setpoints: [], sun: AUTO_SUN }, store.settings.get(), now, autoLight(store))
    if (auto) save(auto, true, spec)
    else {
      store.schedules.upsert({ id: 'auto', kind: 'light', name: 'Auto', enabled: true, days: 127, spec })
      changed.push('auto')
    }
    store.settings.update({ autoLightsOff: [...new Set([...(store.settings.get().autoLightsOff ?? []), ...others.map(s => s.id)])] })
  }
  else {
    for (const s of all.filter(s => isAuto(s) && s.enabled)) save(s, false)
    const back = new Set(store.settings.get().autoLightsOff ?? [])
    for (const s of all.filter(s => back.has(s.id) && !s.enabled)) save(s, true)
    store.settings.update({ autoLightsOff: null })
  }
  return changed
}
