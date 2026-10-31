import { createFileRoute } from '@tanstack/react-router'
import { GrowPage } from '@/src/components/Grow/GrowPage'

export const Route = createFileRoute('/grow')({ component: GrowPage })
