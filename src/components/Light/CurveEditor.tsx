import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, GhostIcon } from '@/src/components/ds/core'
import { DayPicker, Slider, Stepper, TextField, Toggle } from '@/src/components/ds/forms'
import { fmtClock } from '@/src/components/charts/format'
import { daysToList, listToDays } from '@/src/lib/days'
import { followSun, sunDay } from '@/src/scheduler/sun'
import { localTime, systemZone } from '@/src/scheduler/time'
import type { SunFollow } from '@/src/store/types'
import { trpc } from '@/src/utils/trpc'
import type { LightCurve } from './curves'

/** Name, days and setpoints, or how it follows the sun; on/off is the card's toggle and saves at once. */
type Draft = Pick<LightCurve, 'name' | 'days'> & { setpoints: LightCurve['spec']['setpoints'], sun?: SunFollow }
const draftOf = (c: LightCurve): Draft => ({ name: c.name, days: c.days, setpoints: c.spec.setpoints, ...(c.spec.sun && { sun: c.spec.sun }) })

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
      {draft.sun
        ? <SunControls sun={draft.sun} onChange={sun => setDraft({ ...draft, sun })} />
        : (
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
          )}
      <div className="flex flex-wrap items-center gap-2">
        {!draft.sun && <Button variant="dashed" icon={Plus} onClick={() => setPts([...draft.setpoints, { minute: 720, level: 50 }])}>Setpoint</Button>}
        <span className="flex-1" />
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(draftOf(schedule))}>Reset</Button>
        <Button variant="primary" disabled={!dirty} onClick={() => onSave({ ...schedule, name: draft.name, days: draft.days, spec: { setpoints: draft.setpoints, ...(draft.sun && { sun: draft.sun }) } })}>Save</Button>
      </div>
    </div>
  )
}

const hm = (min: number) => [Math.floor(min / 60) && `${Math.floor(min / 60)} h`, min % 60 && `${min % 60} min`].filter(Boolean).join(' ') || '0 min'
const stepper = 'border-line bg-field [&>span]:min-w-16 [&>span]:text-[13px]'

/** How a curve follows the sun, and what that makes today on the unit's clock and at its place. */
function SunControls({ sun, onChange }: { sun: SunFollow, onChange: (sun: SunFollow) => void }) {
  const settings = trpc.settings.get.useQuery()
  const auto = trpc.schedules.autoLight.useQuery(undefined, { enabled: !!sun.auto })
  const place = { latitude: settings.data?.latitude ?? null, longitude: settings.data?.longitude ?? null, timezone: settings.data?.timezone ?? systemZone() }
  const now = new Date()
  const today = place.latitude !== null && place.longitude !== null ? sunDay(localTime(now, place.timezone).date, place.latitude, place.longitude, place.timezone) : null
  const [rise, , , dark] = followSun({ setpoints: [], sun }, place, now, auto.data).setpoints
  const shift = sun.shiftMin === 0 ? 'on midday' : `${hm(Math.abs(sun.shiftMin))} ${sun.shiftMin > 0 ? 'later' : 'earlier'}`
  const row = 'flex flex-wrap items-center justify-between gap-3 border-b border-line py-2 text-[13px]'
  return (
    <div className="flex flex-col">
      <p className="pb-2 text-[13px] text-fg-2 text-pretty" data-testid="sun-today">
        {today
          ? `Today: sunrise ${today.sunrise === null ? '–' : fmtClock(today.sunrise)}, sunset ${today.sunset === null ? '–' : fmtClock(today.sunset)}, ${hm(today.day)} of daylight. `
          : 'Set the unit’s location in Settings to follow sunrise and sunset; until then the day centres on 12:00. '}
        {rise && dark && `The light comes up from ${fmtClock(rise.minute)} and is off by ${fmtClock(dark.minute)}.`}
      </p>
      <div className={row}>
        <span>Hours from the grow protocol</span>
        <Toggle
          on={!!sun.auto}
          size="md"
          label="Hours from the grow protocol"
          // Turned off, it keeps the hours it had, so today's light doesn't jump.
          onChange={on => onChange(on ? { ...sun, auto: true } : { ...sun, auto: false, ...(auto.data && { minHours: auto.data.minHours, maxHours: auto.data.maxHours }) })}
        />
      </div>
      {sun.auto
        ? (
            <p className="border-b border-line py-2 text-[13px] text-fg-2 text-pretty" data-testid="sun-auto">
              {auto.data ? `${auto.data.protocolName}: ${auto.data.minHours}–${auto.data.maxHours} h of full light, ${auto.data.why}.` : ' '}
            </p>
          )
        : (
            <>
              <div className={row}>
                <span>Full light, at least</span>
                <Stepper label="Fewest hours" className={stepper} value={sun.minHours} min={8} max={sun.maxHours} step={0.5} format={v => `${v} h`} onChange={minHours => onChange({ ...sun, minHours })} />
              </div>
              <div className={row}>
                <span>Full light, at most</span>
                <Stepper label="Most hours" className={stepper} value={sun.maxHours} min={sun.minHours} max={18} step={0.5} format={v => `${v} h`} onChange={maxHours => onChange({ ...sun, maxHours })} />
              </div>
            </>
          )}
      <div className={row}>
        <span>Sunrise and sunset take</span>
        <Stepper label="Ramp" className={stepper} value={sun.rampMin} min={0} max={180} step={15} format={v => `${v} min`} onChange={rampMin => onChange({ ...sun, rampMin })} />
      </div>
      <div className={row}>
        <span>{`Centred ${shift}`}</span>
        <Stepper label="Shift" className={stepper} value={sun.shiftMin} min={-180} max={180} step={15} format={v => `${v > 0 ? '+' : ''}${v} min`} onChange={shiftMin => onChange({ ...sun, shiftMin })} />
      </div>
    </div>
  )
}
