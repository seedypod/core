import { createFileRoute } from '@tanstack/react-router'
import { PlanPage } from '@/src/components/Plan/PlanPage'

export const Route = createFileRoute('/plan')({ component: PlanPage })
