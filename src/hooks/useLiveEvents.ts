import { useEffect, useRef } from 'react'
import type { CoreEvent } from '@/src/lib/eventBus'
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
const TOUCHES: Partial<Record<string, readonly Area[]>> = {
  'actuators': ['light', 'pump'],
  'actuators.light': ['light'],
  'actuators.pump': ['pump'],
  // Acknowledging a fault re-enables its actuator.
  'alerts': ['alerts', 'light', 'pump', 'system'],
  'analyses': ['vision', 'grow', 'datasets'],
  // A rule can take or release the light.
  'automations': ['automations', 'light'],
  'backup': ['backup', 'system'],
  'captures': ['camera', 'vision', 'alerts', 'datasets'],
  'devices': ['devices', 'sensors', 'system'],
  'grow': ['grow', 'planner', 'vision', 'alerts'],
  'homekit': ['homekit', 'system'],
  'network': ['network', 'system'],
  'plans': ['planner'],
  'plants': ['plants', 'grow'],
  'pods': ['grow', 'planner', 'vision'],
  'sensors': ['sensors', 'devices'],
}

/** What an event makes stale. */
export function touchedBy(e: CoreEvent): readonly Area[] | 'all' {
  if (e.kind === 'mutation') return TOUCHES[e.path] ?? TOUCHES[e.path.replace(/\..*/, '')] ?? 'all'
  if (e.kind === 'schedule') return ['schedules', 'light']
  switch (e.event.type) {
    case 'sensor': return ['sensors']
    case 'actuator': return [e.event.id === 'light' ? 'light' : 'pump']
    case 'alert': return ['alerts']
    case 'devices': return ['devices', 'sensors']
    default: return ['system']
  }
}

/** A sensor tick arrives as a burst of events, and a command as its mutation plus its actuator state: one refetch answers each. */
export const BURST_MS = 250

/**
 * Subscribes to the core event stream (SSE) and invalidates the queries each
 * event touches, so the UI is live without polling.
 */
export function useLiveEvents() {
  const utils = trpc.useUtils()
  const pending = useRef(new Set<Area | 'all'>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = () => {
    const areas = pending.current
    pending.current = new Set()
    timer.current = null
    if (areas.has('all')) void utils.invalidate()
    else for (const area of areas as Set<Area>) void utils[area].invalidate()
  }
  trpc.events.onChange.useSubscription(undefined, {
    onData(e) {
      const touched = touchedBy(e)
      for (const area of touched === 'all' ? ['all' as const] : touched) pending.current.add(area)
      timer.current ??= setTimeout(flush, BURST_MS)
    },
  })
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
}
