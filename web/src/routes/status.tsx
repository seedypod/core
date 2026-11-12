import { createFileRoute } from '@tanstack/react-router'
import { StatusPage } from '@/src/components/System/StatusPage'

export const Route = createFileRoute('/status')({ component: StatusPage })
