import { CalendarDays, Sprout } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/src/components/ds/core'
import { fmtDay } from '@/src/components/Water/pumpCycles'
import { MAX_BACKDATE_DAYS } from '@/src/grow/grow'

/** A date on the unit's calendar (YYYY-MM-DD), as a moment fmtDay reads the same anywhere. */
const onDay = (date: string) => new Date(`${date}T12:00:00Z`)
/** The calendar date `days` before `date`. */
const daysBefore = (date: string, days: number) => new Date(onDay(date).getTime() - days * 86_400_000).toISOString().slice(0, 10)

/**
 * The grow protocol track's left end (ADR-0030): the day the tower was sown, with Change
 * to move the grow cycle's start to another day, as far back as a cycle may
 * be dated and no later than today. With no grow cycle open, once the unit
 * has said so, Start germination today instead; while that's still unknown,
 * nothing.
 */
export function SownOn({ sowDate, cycle, today, note, onChange, onStartToday }: {
  /** The sowing date on the unit's calendar, YYYY-MM-DD; null with none. */
  sowDate: string | null
  /** Whether a grow cycle is open, so its start can be moved; unknown until the unit answers. */
  cycle: 'open' | 'none' | 'unknown'
  /** Today on the unit's calendar, the latest a start can be. */
  today: string
  /** Said under the date: why the weekly run stays where it is. */
  note?: string | null
  /** Moves the start; the editor stays open until it settles, and shows why if it fails. */
  onChange: (date: string) => Promise<unknown>
  onStartToday: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [date, setDate] = useState(today)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const earliest = daysBefore(today, MAX_BACKDATE_DAYS)
  const close = () => {
    setEditing(false)
    setError(null)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[12px] text-fg-2" data-testid="sown">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {cycle === 'open' && sowDate !== null && !editing && (
          <>
            <span className="flex items-center gap-1.5" data-testid="sown-on">
              <Sprout size={14} aria-hidden className="shrink-0 text-pod-ok" />
              {`Sown ${fmtDay(onDay(sowDate), 'UTC')}`}
            </span>
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-fg underline underline-offset-2"
              onClick={() => {
                setDate(sowDate)
                setError(null)
                setEditing(true)
              }}
            >
              Change
            </button>
          </>
        )}
        {cycle === 'open' && editing && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setSaving(true)
              setError(null)
              onChange(date).then(close, (err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setSaving(false))
            }}
          >
            <label className="flex items-center gap-1.5">
              <CalendarDays size={14} aria-hidden className="shrink-0" />
              Sown on
              <input type="date" className="lp-btn font-mono text-[12px]" value={date} min={earliest} max={today} required onChange={e => setDate(e.target.value)} />
            </label>
            <Button size="sm" variant="primary" type="submit" disabled={saving || !date || date > today || date < earliest}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button size="sm" disabled={saving} onClick={close}>Cancel</Button>
            {error && <span className="basis-full text-danger" role="alert">{error}</span>}
          </form>
        )}
        {cycle === 'none' && <Button size="sm" icon={Sprout} onClick={onStartToday}>Start germination today</Button>}
      </div>
      {note && cycle === 'open' && <span className="text-fg-3" data-testid="sown-note">{note}</span>}
    </div>
  )
}
