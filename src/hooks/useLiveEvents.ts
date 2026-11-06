import { useEffect, useRef } from 'react'
import type { Reading, SensorId } from '@/src/hardware/contract'
import type { CoreEvent } from '@/src/lib/eventBus'
import { isOlder } from '@/src/lib/readings'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type Area = Exclude<keyof AppRouter['_def']['record'], 'events'>

/**
 * The tRPC routers each mutation path can change, by full path and then by its
 * first segment. A path missing here refreshes everything, so a new emit site
 * is slow until listed but never stale. `settings` is missing on purpose:
 * nearly every area reads it, and it changes rarely.
 *
 * `system` is kept off the paths a person fires in quick succession. Its
 * `checks` query is the slowest on the unit, and polls every 30 to 60 s anyway.
 */
const TOUCHES = new Map<string, readonly Area[]>([
  ['actuators', ['light', 'pump']],
  ['actuators.light', ['light']],
  ['actuators.pump', ['pump']],
  // Acknowledging a fault re-enables its actuator.
  ['alerts', ['alerts', 'light', 'pump', 'system']],
  ['analyses', ['vision', 'grow', 'datasets']],
  // A rule can take or release the light.
  ['automations', ['automations', 'light']],
  ['backup', ['backup', 'system']],
  ['captures', ['camera', 'vision', 'alerts', 'datasets']],
  ['devices', ['devices', 'sensors', 'system']],
  ['grow', ['grow', 'planner', 'vision', 'alerts']],
  ['homekit', ['homekit', 'system']],
  ['network', ['network', 'system']],
  ['plans', ['planner']],
  ['plants', ['plants', 'grow']],
  ['pods', ['grow', 'planner', 'vision']],
  ['sensors', ['sensors', 'devices']],
])

/** What an event makes stale. */
export function touchedBy(e: CoreEvent): readonly Area[] | 'all' {
  if (e.kind === 'mutation') return TOUCHES.get(e.path) ?? TOUCHES.get(e.path.replace(/\..*/, '')) ?? 'all'
  if (e.kind === 'schedule') return ['schedules', 'light']
  switch (e.event.type) {
    // Carries its reading, so the cache takes the value and nothing needs fetching.
    case 'sensor': return []
    case 'actuator': return [e.event.id === 'light' ? 'light' : 'pump']
    case 'alert': return ['alerts']
    case 'devices': return ['devices', 'sensors']
    default: return ['system']
  }
}

/** A sensor tick arrives as a burst of events, and a command as its mutation plus its actuator state: one cache write and one refetch answer each. */
export const BURST_MS = 250

/**
 * Subscribes to the core event stream (SSE), writes each sensor reading into
 * the `sensors.latest` cache and invalidates the queries any other event
 * touches, so the UI is live without polling. A reading for a sensor the cache
 * doesn't know, and a reconnect (it may have missed readings), refetch instead.
 */
export function useLiveEvents() {
  const utils = trpc.useUtils()
  const pending = useRef(new Set<Area | 'all'>())
  const readings = useRef(new Map<SensorId, Reading>())
  const connected = useRef(false)
  const failed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedule = () => {
    timer.current ??= setTimeout(flush, BURST_MS)
  }
  const flush = () => {
    const areas = pending.current
    const fresh = readings.current
    pending.current = new Set()
    readings.current = new Map()
    timer.current = null
    // Nothing cached means the first fetch hasn't landed, and it brings them all.
    const known = utils.sensors.latest.getData()
    if (known && fresh.size) {
      if ([...fresh.keys()].some(id => !known[id])) areas.add('sensors')
      utils.sensors.latest.setData(undefined, { ...known, ...Object.fromEntries(fresh) })
    }
    if (areas.has('all')) void utils.invalidate()
    else for (const area of areas as Set<Area>) void utils[area].invalidate()
  }
  const stream = trpc.events.onChange.useSubscription(undefined, {
    onStarted() {
      if (connected.current || failed.current) {
        pending.current.add('sensors')
        schedule()
      }
      connected.current = true
      failed.current = false
    },
    onData(e) {
      const touched = touchedBy(e)
      for (const area of touched === 'all' ? ['all' as const] : touched) pending.current.add(area)
      if (e.kind === 'hal' && e.event.type === 'sensor' && !isOlder(e.event.reading, readings.current.get(e.event.id))) {
        readings.current.set(e.event.id, e.event.reading)
      }
      schedule()
    },
  })
  // A first attempt that fails can miss readings after the initial fetch, so its retry counts as a reconnect.
  useEffect(() => {
    if (stream.error) failed.current = true
  }, [stream.error])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
}
