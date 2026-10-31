import { createFileRoute } from '@tanstack/react-router'
import { CamerasPage } from '@/src/components/Cameras/CamerasPage'

export const Route = createFileRoute('/cameras')({ component: CamerasPage })
