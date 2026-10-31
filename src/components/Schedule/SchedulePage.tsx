import { CalendarClock, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, GhostIcon, SectionLabel } from '@/src/components/ds/core'
import { DayPicker, SegmentedControl, TextField, Toggle } from '@/src/components/ds/forms'
import { Modal } from '@/src/components/ds/feedback'
import { PageHeader } from '@/src/components/ds/layout'
import { fmtClock } from '@/src/components/charts/LineChart'
import { daysLabel, daysToList, listToDays } from './days'
import { trpc } from '@/src/utils/trpc'

interface PumpSched { id: string, kind: 'pump', name: string, enabled: boolean, days: number, spec: { minute: number, durationS: number, level?: number } }
const DURATIONS = ['60', '180', '300', '600', '900'] as const

export function SchedulePage() {
  const utils = trpc.useUtils()
  const schedules = trpc.schedules.list.useQuery()
  const upsert = trpc.schedules.upsert.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const remove = trpc.schedules.remove.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const [editing, setEditing] = useState<PumpSched | null>(null)
  const pumps: PumpSched[] = (schedules.data ?? []).flatMap(s => (s.kind === 'pump' && 'durationS' in s.spec ? [{ id: s.id, kind: 'pump' as const, name: s.name, enabled: s.enabled, days: s.days, spec: s.spec }] : []))
  const lights = (schedules.data ?? []).filter(s => s.kind === 'light')

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Schedule" right={<Button size="sm" icon={Plus} onClick={() => setEditing({ id: `pump-${Date.now().toString(36)}`, kind: 'pump', name: 'Watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })}>Pump cycle</Button>} />

      <SectionLabel>Pump cycles</SectionLabel>
      {pumps.length === 0 && <Card dashed><p className="text-[13px] text-fg-2">No pump cycles. Each run is bounded by the hardware max-run and refused when the tank is low.</p></Card>}
      {pumps.map(s => (
        <Card key={s.id} highlight={s.enabled}>
          <div className="flex items-center gap-3">
            <CalendarClock size={18} className="text-icon" />
            <button type="button" className="flex-1 text-left" onClick={() => setEditing(s)}>
              <div className="text-[15px]">{s.name}</div>
              <div className="text-[12px] text-fg-2">
                {fmtClock(s.spec.minute)}
                {' '}
                ·
                {' '}
                {Math.round(s.spec.durationS / 60)}
                {' '}
                min
                {s.spec.level ? ` at ${s.spec.level}%` : ''}
                {' '}
                ·
                {' '}
                {daysLabel(s.days)}
              </div>
            </button>
            <Toggle on={s.enabled} label={`Enable ${s.name}`} onChange={enabled => upsert.mutate({ ...s, enabled })} />
            <GhostIcon icon={Trash2} label="Delete" onClick={() => remove.mutate({ id: s.id })} />
          </div>
        </Card>
      ))}

      <SectionLabel>Light curves</SectionLabel>
      {lights.length === 0 && <Card dashed><p className="text-[13px] text-fg-2">No light curves — add one on the Light page.</p></Card>}
      {lights.map(s => (
        <Card key={s.id} highlight={s.enabled}>
          <CardHeader title={s.name} subtitle={`${'setpoints' in s.spec ? s.spec.setpoints.length : 0} setpoints · ${daysLabel(s.days)}`} right={<Toggle on={s.enabled} label={`Enable ${s.name}`} onChange={enabled => upsert.mutate({ ...s, enabled })} />} />
        </Card>
      ))}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.name ?? ''}
        icon={CalendarClock}
        footer={editing && (
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                upsert.mutate(editing)
                setEditing(null)
              }}
            >
              Save
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        )}
      >
        {editing && (
          <div className="flex flex-col gap-4">
            <TextField label="Name" mono={false} value={editing.name} onChange={v => setEditing({ ...editing, name: v })} />
            <label className="flex flex-col gap-1.5 text-xs text-fg-2">
              Time
              <input
                type="time"
                className="lp-btn font-mono"
                value={fmtClock(editing.spec.minute)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number)
                  setEditing({ ...editing, spec: { ...editing.spec, minute: (h ?? 0) * 60 + (m ?? 0) } })
                }}
              />
            </label>
            <div className="flex flex-col gap-1.5 text-xs text-fg-2">
              Duration
              <SegmentedControl value={String(editing.spec.durationS) as typeof DURATIONS[number]} options={DURATIONS.map(d => ({ value: d, label: `${Number(d) / 60} min` }))} onChange={v => setEditing({ ...editing, spec: { ...editing.spec, durationS: Number(v) } })} />
            </div>
            <div className="flex flex-col gap-1.5 text-xs text-fg-2">
              Days
              <DayPicker value={daysToList(editing.days)} onChange={v => setEditing({ ...editing, days: listToDays(v) })} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
