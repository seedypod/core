import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/src/components/Placeholder'

export const Route = createFileRoute('/water')({ component: () => <Placeholder title="Water" /> })
