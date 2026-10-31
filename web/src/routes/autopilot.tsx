import { createFileRoute } from '@tanstack/react-router'
import { AutopilotPage } from '@/src/components/Autopilot/AutopilotPage'

export const Route = createFileRoute('/autopilot')({ component: AutopilotPage })
