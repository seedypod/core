import { createFileRoute } from '@tanstack/react-router'
import { SensorsPage } from '@/src/components/Sensors/SensorsPage'

export const Route = createFileRoute('/sensors')({ component: SensorsPage })
