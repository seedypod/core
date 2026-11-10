import { createFileRoute } from '@tanstack/react-router'
import { CarePage } from '@/src/components/Care/CarePage'

export const Route = createFileRoute('/care')({ component: CarePage })
