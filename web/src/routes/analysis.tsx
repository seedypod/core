import { createFileRoute } from '@tanstack/react-router'
import { AnalysisPage, isAnalysisTab, type AnalysisTab } from '@/src/components/Analysis/AnalysisPage'

/** `?tab=teach` or `?tab=methods` opens that tab (the sidebar's Pods out of order links to Teach). */
export const Route = createFileRoute('/analysis')({
  component: function Analysis() {
    return <AnalysisPage tab={Route.useSearch().tab} />
  },
  validateSearch: (search: Record<string, unknown>): { tab?: AnalysisTab } => (isAnalysisTab(search.tab) ? { tab: search.tab } : {}),
})
