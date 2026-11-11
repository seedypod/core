import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
import { AppShell } from '@/src/components/AppShell/AppShell'
import { useSnackbars } from '@/src/components/AppShell/useSnackbars'
import { ToastProvider } from '@/src/components/ds/toast'
import { useLiveEvents } from '@/src/hooks/useLiveEvents'
import { setUnitSystem, systemFor } from '@/src/lib/units'
import { trpc } from '@/src/utils/trpc'

/** The live event stream, and the snackbars it raises (none on the kiosk). */
function Live() {
  useLiveEvents(useSnackbars())
  return null
}

function Root() {
  const { pathname } = useLocation()
  // Every page formats through the display units; a change remounts them so none keeps the old ones.
  const units = systemFor(trpc.settings.get.useQuery().data?.temperatureUnit)
  setUnitSystem(units)
  // One provider over both branches keeps Live in place, so the event stream outlives a move to or from the kiosk.
  return (
    <ToastProvider>
      <Live />
      {pathname.startsWith('/kiosk')
        ? <Outlet key={units} />
        : (
            <AppShell key={units}>
              <Outlet />
            </AppShell>
          )}
    </ToastProvider>
  )
}

export const Route = createRootRoute({ component: Root })
