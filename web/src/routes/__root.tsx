import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
import { AppShell } from '@/src/components/AppShell/AppShell'
import { useLiveEvents } from '@/src/hooks/useLiveEvents'

function Root() {
  useLiveEvents()
  const { pathname } = useLocation()
  if (pathname.startsWith('/kiosk')) return <Outlet />
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

export const Route = createRootRoute({ component: Root })
