import { createFileRoute } from '@tanstack/react-router'
import { GrowPage } from '@/src/components/Grow/GrowPage'

/** `?pod=N` opens that pod in the side panel (Home links here). */
export const Route = createFileRoute('/grow')({
  component: GrowPage,
  validateSearch: (search: Record<string, unknown>): { pod?: number } => {
    const pod = Number(search.pod)
    return Number.isInteger(pod) && pod > 0 ? { pod } : {}
  },
})
