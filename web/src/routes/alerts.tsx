import { createFileRoute } from '@tanstack/react-router'
import { AlertsPage } from '@/src/components/Alerts/AlertsPage'

export const Route = createFileRoute('/alerts')({ component: AlertsPage })
