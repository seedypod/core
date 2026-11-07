import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, GhostIcon } from '@/src/components/ds/core'
import { DayPicker, Slider, TextField } from '@/src/components/ds/forms'
import { fmtClock } from '@/src/components/charts/format'
import { daysToList, listToDays } from '@/src/lib/days'
import type { LightCurve } from './curves'

/** Name, days and setpoints; on/off is the card's toggle and saves at once. */
type Draft = Pick<LightCurve, 'name' | 'days'> & { setpoints: LightCurve['spec']['setpoints'] }
const draftOf = (c: LightCurve): Draft => ({ name: c.name, days: c.days, setpoints: c.spec.setpoints })

export function CurveEditor({ schedule, onSave }: { schedule: LightCurve, onSave: (next: LightCurve) => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(schedule))
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(schedule))
  const setPts = (setpoints: Draft['setpoints']) => setDraft({ ...draft, setpoints })
  // Rows show in time order but edit the setpoint they came from, so a row doesn't jump while its time is typed.
  const rows = draft.setpoints.map((p, i) => ({ p, i })).sort((a, b) => a.p.minute - b.p.minute)
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <DayPicker value={daysToList(draft.days)} onChange={v => setDraft({ ...draft, days: listToDays(v) })} labels={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']} className="w-fit grid-cols-[repeat(7,34px)]" />
        <TextField aria-label="Curve name" value={draft.name} onChange={v => setDraft({ ...draft, name: v })} mono={false} className="ml-auto w-[200px]" />
      </div>
      <div className="flex flex-col">
        {rows.map(({ p, i }) => (
          <div key={i} className="flex items-center gap-4 border-b border-line py-2">
            <input
              type="time"
              value={fmtClock(p.minute)}
              aria-label="Setpoint time"
              className="w-[78px] rounded-ctl border border-line bg-transparent px-2.5 py-1.5 text-center font-mono text-sm font-medium text-fg [&::-webkit-calendar-picker-indicator]:hidden"
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number)
                const pts = [...draft.setpoints]
                pts[i] = { ...p, minute: (h ?? 0) * 60 + (m ?? 0) }
                setPts(pts)
              }}
            />
            <Slider
              value={p.level}
              label="Setpoint level"
              onChange={(level) => {
                const pts = [...draft.setpoints]
                pts[i] = { ...p, level }
                setPts(pts)
              }}
            />
            <span className="w-11 text-right font-mono text-[12px] text-fg-2">{`${p.level}%`}</span>
            <GhostIcon icon={Trash2} label="Remove setpoint" className="text-fg-3 hover:text-danger" onClick={() => setPts(draft.setpoints.filter((_, j) => j !== i))} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="dashed" icon={Plus} onClick={() => setPts([...draft.setpoints, { minute: 720, level: 50 }])}>Setpoint</Button>
        <span className="flex-1" />
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(draftOf(schedule))}>Reset</Button>
        <Button variant="primary" disabled={!dirty} onClick={() => onSave({ ...schedule, name: draft.name, days: draft.days, spec: { setpoints: draft.setpoints } })}>Save</Button>
      </div>
    </div>
  )
}
