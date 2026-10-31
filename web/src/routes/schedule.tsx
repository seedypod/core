import { createFileRoute } from '@tanstack/react-router'
import { SchedulePage } from '@/src/components/Schedule/SchedulePage'

export const Route = createFileRoute('/schedule')({ component: SchedulePage })
