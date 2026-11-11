import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
import { AppShell } from '@/src/components/AppShell/AppShell'
import { useSnackbars } from '@/src/components/AppShell/useSnackbars'
import { ToastProvider } from '@/src/components/ds/toast'
import { useLiveEvents } from '@/src/hooks/useLiveEvents'
import { setUnitSystem, systemFor } from '@/src/lib/units'
import { trpc } from '@/src/utils/trpc'

/** The live event stream, and the snackbars it raises; the kiosk has no toast region, so it shows none. */
function Live() {
  useLiveEvents(useSnackbars())
  return null
}

function Root() {
  const { pathname } = useLocation()
  // Every page formats through the display units; a change remounts them so none keeps the old ones.
  const units = systemFor(trpc.settings.get.useQuery().data?.temperatureUnit)
  setUnitSystem(units)
  if (pathname.startsWith('/kiosk')) {
    return (
      <>
        <Live />
        <Outlet key={units} />
      </>
    )
  }
  return (
    <ToastProvider>
      <Live />
      <AppShell key={units}>
        <Outlet />
      </AppShell>
    </ToastProvider>
  )
}

export const Route = createRootRoute({ component: Root })
