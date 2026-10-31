import { useEffect } from 'react'
import { queryClient, trpc } from '@/src/utils/trpc'

/**
 * Subscribes to the core event stream (SSE) and invalidates the queries each
 * event touches, so the UI is live without polling.
 */
export function useLiveEvents() {
  const utils = trpc.useUtils()
  trpc.events.onChange.useSubscription(undefined, {
    onData(e) {
      if (e.kind === 'hal') {
        if (e.event.type === 'sensor') void utils.sensors.invalidate()
        else if (e.event.type === 'actuator') void (e.event.id === 'light' ? utils.light.invalidate() : utils.pump.invalidate())
        else if (e.event.type === 'alert') void utils.alerts.invalidate()
        else if (e.event.type === 'devices') {
          void utils.devices.invalidate()
          void utils.sensors.invalidate()
        }
        else void utils.system.invalidate()
      }
      else if (e.kind === 'mutation') {
        void queryClient.invalidateQueries()
      }
    },
  })
  useEffect(() => () => undefined, [])
}
