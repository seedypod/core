import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { useCoreStatus } from './useCoreStatus'

export function AppShell({ children }: { children: ReactNode }) {
  const status = useCoreStatus()
  return (
    <div className="flex min-h-dvh bg-app text-fg">
      <Sidebar status={status} />
      <main className="flex-1 px-4 pb-24 pt-4 min-[900px]:px-8 min-[900px]:pb-8">{children}</main>
      <TabBar />
    </div>
  )
}
