import { createFileRoute } from '@tanstack/react-router'
import { LightPage } from '@/src/components/Light/LightPage'

export const Route = createFileRoute('/light')({ component: LightPage })
