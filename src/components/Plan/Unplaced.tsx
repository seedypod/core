import { InlineError } from '@/src/components/ds/core'

interface Props {
  unplaced: { plantId: string, plantName: string, reason: string }[]
  suggestions: { plantId: string, text: string }[]
}

/** What did not fit and why (the zones it could use and how full they are), with the planner's suggested moves. */
export function Unplaced({ unplaced, suggestions }: Props) {
  if (unplaced.length === 0) return null
  const groups = new Map<string, { plantName: string, reason: string, n: number }>()
  for (const u of unplaced) {
    const key = `${u.plantId}|${u.reason}`
    const g = groups.get(key)
    if (g) g.n++
    else groups.set(key, { plantName: u.plantName, reason: u.reason, n: 1 })
  }
  return (
    <div className="mt-3 flex flex-col gap-1">
      {[...groups.entries()].map(([key, g]) => (
        <InlineError key={key}>{`Didn’t fit: ${g.plantName}${g.n > 1 ? ` ×${g.n}` : ''} — ${g.reason}`}</InlineError>
      ))}
      {suggestions.length > 0 && (
        <ul aria-label="Suggested moves" className="list-disc pl-5 text-[12px] text-fg-2">
          {suggestions.map(s => <li key={s.text}>{s.text}</li>)}
        </ul>
      )}
    </div>
  )
}
