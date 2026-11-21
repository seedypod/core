import { createFileRoute } from '@tanstack/react-router'
import { GrowPage, isGrowTab, type GrowTab } from '@/src/components/Grow/GrowPage'

/** `?pod=N` opens that pod in the side panel (Home links here); `?tab=protocol` or `?tab=pods` opens that tab. */
export const Route = createFileRoute('/grow')({
  component: function Grow() {
    const { tab, pod } = Route.useSearch()
    return <GrowPage tab={tab} pod={pod} />
  },
  validateSearch: (search: Record<string, unknown>): { pod?: number, tab?: GrowTab } => {
    const pod = Number(search.pod)
    return { ...(Number.isInteger(pod) && pod > 0 && { pod }), ...(isGrowTab(search.tab) && { tab: search.tab }) }
  },
})
