import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '@/src/components/Settings/SettingsPage'

export const Route = createFileRoute('/settings')({ component: SettingsPage })
