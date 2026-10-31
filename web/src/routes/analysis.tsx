import { createFileRoute } from '@tanstack/react-router'
import { AnalysisPage } from '@/src/components/Analysis/AnalysisPage'

export const Route = createFileRoute('/analysis')({ component: AnalysisPage })
