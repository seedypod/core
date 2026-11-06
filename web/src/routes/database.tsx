import { createFileRoute } from '@tanstack/react-router'
import { DatabasePage } from '@/src/components/Database/DatabasePage'

export const Route = createFileRoute('/database')({ component: DatabasePage })
