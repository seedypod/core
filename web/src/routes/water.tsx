import { createFileRoute } from '@tanstack/react-router'
import { WaterPage } from '@/src/components/Water/WaterPage'

export const Route = createFileRoute('/water')({ component: WaterPage })
