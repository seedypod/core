import { createRootRoute, Outlet } from '@tanstack/react-router'
import { AppShell } from '@/src/components/AppShell/AppShell'
import { useLiveEvents } from '@/src/hooks/useLiveEvents'

function Root() {
  useLiveEvents()
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

export const Route = createRootRoute({ component: Root })
