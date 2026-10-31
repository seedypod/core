import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, GhostIcon } from '@/src/components/ds/core'
import { DayPicker, TextField, Toggle } from '@/src/components/ds/forms'
import { fmtClock } from '@/src/components/charts/LineChart'
import { daysToList, listToDays } from '@/src/components/Schedule/days'

interface Curve { id: string, kind: 'light', name: string, enabled: boolean, days: number, spec: { setpoints: { minute: number, level: number }[] } }

export function CurveEditor({ schedule, onSave }: { schedule: Curve, onSave: (next: Curve) => void }) {
  const [draft, setDraft] = useState<Curve>(schedule)
  const dirty = JSON.stringify(draft) !== JSON.stringify(schedule)
  const setPts = (setpoints: Curve['spec']['setpoints']) => setDraft({ ...draft, spec: { setpoints } })
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <TextField label="Name" value={draft.name} onChange={v => setDraft({ ...draft, name: v })} mono={false} className="min-w-[180px] flex-1" />
        <Toggle on={draft.enabled} onChange={enabled => setDraft({ ...draft, enabled })} label="Enabled" size="md" />
      </div>
      <DayPicker value={daysToList(draft.days)} onChange={v => setDraft({ ...draft, days: listToDays(v) })} />
      <div className="flex flex-col gap-2">
        {[...draft.spec.setpoints].sort((a, b) => a.minute - b.minute).map((p, i) => (
          <div key={`${p.minute}-${i}`} className="flex items-center gap-2">
            <input
              type="time"
              value={fmtClock(p.minute)}
              aria-label="Setpoint time"
              className="lp-btn font-mono"
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number)
                const pts = [...draft.spec.setpoints]
                pts[i] = { ...p, minute: (h ?? 0) * 60 + (m ?? 0) }
                setPts(pts)
              }}
            />
            <input
              type="range"
              min={0}
              max={100}
              value={p.level}
              aria-label="Setpoint level"
              className="flex-1 accent-[var(--accent-light)]"
              onChange={(e) => {
                const pts = [...draft.spec.setpoints]
                pts[i] = { ...p, level: Number(e.target.value) }
                setPts(pts)
              }}
            />
            <span className="w-10 text-right font-mono text-[12px] text-fg-2">
              {p.level}
              %
            </span>
            <GhostIcon icon={Trash2} label="Remove setpoint" onClick={() => setPts(draft.spec.setpoints.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" icon={Plus} onClick={() => setPts([...draft.spec.setpoints, { minute: 720, level: 50 }])}>Add setpoint</Button>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" disabled={!dirty} onClick={() => onSave(draft)}>Save</Button>
        <Button disabled={!dirty} onClick={() => setDraft(schedule)}>Reset</Button>
      </div>
    </div>
  )
}
