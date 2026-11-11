import { CalendarDays, Sprout } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/src/components/ds/core'

/** A date on the unit's calendar (YYYY-MM-DD), written "Mon 9 Nov". */
export const fmtCalendarDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * The top of the watering presets: the day the tower was sown, with Change
 * to move the grow cycle's start to another day, no later than today; with no
 * grow cycle open, Start germination today instead.
 */
export function SownOn({ sowDate, open, today, busy, error, onChange, onStartToday }: {
  /** The sowing date on the unit's calendar, YYYY-MM-DD; null with none. */
  sowDate: string | null
  /** A grow cycle is open, so its start can be moved. */
  open: boolean
  /** Today on the unit's calendar, the latest a start can be. */
  today: string
  busy: boolean
  error: string | null
  onChange: (date: string) => void
  onStartToday: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [date, setDate] = useState(today)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-2" data-testid="sown">
      {open && sowDate !== null && !editing && (
        <>
          <span className="flex items-center gap-1.5" data-testid="sown-on">
            <Sprout size={14} aria-hidden className="shrink-0 text-pod-ok" />
            {`Sown ${fmtCalendarDate(sowDate)}`}
          </span>
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-fg underline underline-offset-2"
            onClick={() => {
              setDate(today)
              setEditing(true)
            }}
          >
            Change
          </button>
        </>
      )}
      {open && editing && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onChange(date)
            setEditing(false)
          }}
        >
          <label className="flex items-center gap-1.5">
            <CalendarDays size={14} aria-hidden className="shrink-0" />
            Sown on
            <input type="date" className="lp-btn font-mono text-[12px]" value={date} max={today} required onChange={e => setDate(e.target.value)} />
          </label>
          <Button size="sm" variant="primary" type="submit" disabled={busy || !date || date > today}>Save</Button>
          <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
      {!open && <Button size="sm" icon={Sprout} disabled={busy} onClick={onStartToday}>Start germination today</Button>}
      {error && <span className="text-danger" role="alert">{error}</span>}
    </div>
  )
}
