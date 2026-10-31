import { Bell, Check, X } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, SectionLabel, StatusDot } from '@/src/components/ds/core'
import { SegmentedControl } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { trpc } from '@/src/utils/trpc'

const LABEL: Record<string, string> = {
  water_low: 'Water low', pump_fault: 'Pump fault', dose_fault: 'Dosing lockout', over_temp: 'Board over temperature', camera_missing: 'Camera missing', hal_offline: 'Hardware daemon offline',
  reminder_thinning: 'Thin seedlings', reminder_root_check: 'Check roots', reminder_harvest: 'Harvest window', reminder_nutrients: 'Add nutrients', light_fault: 'Light fault',
}
const DANGER = new Set(['pump_fault', 'dose_fault', 'over_temp', 'hal_offline'])

export function AlertsPage() {
  const utils = trpc.useUtils()
  const [view, setView] = useState<'active' | 'all'>('active')
  const alerts = trpc.alerts.list.useQuery({ activeOnly: view === 'active' })
  const ack = trpc.alerts.acknowledge.useMutation({
    onSuccess: () => {
      void utils.alerts.invalidate()
      void utils.pump.invalidate()
    },
  })
  const dismiss = trpc.alerts.dismiss.useMutation({ onSuccess: () => utils.alerts.invalidate() })
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Alerts" right={<SegmentedControl size="sm" value={view} onChange={setView} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'History' }]} />} />
      {(alerts.data ?? []).length === 0 && <Card dashed><p className="text-[13px] text-fg-2">Nothing to see. Faults latch here until you acknowledge them; reminders clear when you mark the chore done.</p></Card>}
      {(alerts.data ?? []).map(a => (
        <Card key={a.id} tone={a.active ? (DANGER.has(a.kind) ? 'danger' : 'warn') : undefined}>
          <div className="flex items-start gap-3">
            <Bell size={18} className="mt-0.5 text-icon" />
            <div className="flex-1">
              <div className="flex items-center gap-2 text-[15px]">
                {LABEL[a.kind] ?? a.kind}
                {' '}
                <StatusDot tone={a.active ? (DANGER.has(a.kind) ? 'danger' : 'warn') : 'muted'} />
              </div>
              <div className="text-[13px] text-fg-2">{a.detail}</div>
              <div className="mt-1 font-mono text-[11px] text-fg-3">
                {new Date(a.raisedAt).toLocaleString()}
                {a.clearedAt ? ` → cleared ${new Date(a.clearedAt).toLocaleString()}` : ''}
                {a.acknowledgedAt ? ' · acknowledged' : ''}
              </div>
            </div>
            {a.active && (
              <div className="flex gap-1">
                <Button size="sm" variant="primary" icon={Check} onClick={() => ack.mutate({ id: a.id })}>{a.kind.startsWith('reminder_') ? 'Done' : 'Acknowledge'}</Button>
                <Button size="sm" icon={X} onClick={() => dismiss.mutate({ id: a.id })}>Dismiss</Button>
              </div>
            )}
          </div>
        </Card>
      ))}
      {view === 'active' && <SectionLabel>Acknowledging a hardware fault re-enables the actuator — fix the cause first (refill the tank, let the board cool).</SectionLabel>}
    </div>
  )
}
