import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/src/components/Placeholder'

export const Route = createFileRoute('/light')({ component: () => <Placeholder title="Light" /> })
