import { Card, CardHeader } from '@/src/components/ds/core'

export function Placeholder({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader title={title} subtitle="Coming in a later phase — see docs/implementation-plan.md" />
    </Card>
  )
}
