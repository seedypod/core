import { createFileRoute } from '@tanstack/react-router'
import { WifiPage } from '@/src/components/Wifi/WifiPage'

export const Route = createFileRoute('/wifi')({ component: WifiPage })
