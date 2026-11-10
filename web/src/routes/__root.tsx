import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
import { AppShell } from '@/src/components/AppShell/AppShell'
import { useLiveEvents } from '@/src/hooks/useLiveEvents'
import { setUnitSystem, systemFor } from '@/src/lib/units'
import { trpc } from '@/src/utils/trpc'

function Root() {
  useLiveEvents()
  const { pathname } = useLocation()
  // Every page formats through the display units; a change remounts them so none keeps the old ones.
  const units = systemFor(trpc.settings.get.useQuery().data?.temperatureUnit)
  setUnitSystem(units)
  if (pathname.startsWith('/kiosk')) return <Outlet key={units} />
  return (
    <AppShell key={units}>
      <Outlet />
    </AppShell>
  )
}

export const Route = createRootRoute({ component: Root })
