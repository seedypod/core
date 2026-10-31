import { createFileRoute } from '@tanstack/react-router'
import { KioskPage } from '@/src/components/Kiosk/KioskPage'

export const Route = createFileRoute('/kiosk')({ component: KioskPage })
