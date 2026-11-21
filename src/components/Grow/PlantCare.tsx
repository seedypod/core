import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type Care = inferRouterOutputs<AppRouter>['planner']['care']

const span = (d: [number, number] | null, unit: string) => d ? `${d[0] === d[1] ? d[0] : `${d[0]}–${d[1]}`} ${unit}` : null
const NOTES: [keyof NonNullable<Care['notes']>, string][] = [['harvest', 'Harvest'], ['prune', 'Pruning'], ['support', 'Support'], ['pollinate', 'Pollinating'], ['health', 'Pests'], ['climate', 'Climate']]

/** "Keep 3 sprouts", "Don't thin", with `~` when it is the rule for the plant's kind rather than its own count. */
export function thinText(c: Pick<Care, 'thinTo' | 'thinEstimated'>): string {
  if (c.thinTo === 'all') return 'Don’t thin'
  return `${c.thinEstimated ? '~' : ''}Keep ${c.thinTo} sprout${c.thinTo === 1 ? '' : 's'}`
}

/** The facts as rows, each only when Gardyn gives it. */
export function careRows(c: Care): [string, string][] {
  const rows: [string, string | null][] = [
    ['Thinning', thinText(c)],
    ['Sprouts in', span(c.sproutDays, 'days')],
    ['Matures in', span(c.maturityDays, 'days')],
    ['Height', c.heightFt ? `${c.heightFt} ft` : null],
    ['Temperature', span(c.tempF, '°F')],
  ]
  return rows.filter((r): r is [string, string] => r[1] !== null)
}

/**
 * A planted pod's plant, from its page in Gardyn's help centre: how many
 * sprouts to keep, how long it takes, how big it gets, and its care and
 * harvest notes. Nothing for a plant the catalog doesn't know.
 */
export function PlantCare({ plant }: { plant: string }) {
  const care = trpc.planner.care.useQuery({ id: plant }, { retry: false, staleTime: Infinity })
  const c = care.data
  if (!c) return null
  const notes = NOTES.flatMap(([k, label]) => c.notes?.[k] ? [[label, c.notes[k]] as const] : [])
  return (
    <div data-testid="plant-care" className="flex flex-col border-t border-line">
      {careRows(c).map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-3 border-b border-line/70 py-2.5 text-[13px]">
          <span className="shrink-0 text-fg-2">{label}</span>
          <span className="font-mono">{value}</span>
        </div>
      ))}
      {notes.length > 0 && (
        <details className="py-2.5 text-[13px]">
          <summary className="cursor-pointer text-fg-2">Care and harvest</summary>
          <dl className="mt-2 flex flex-col gap-2">
            {notes.map(([label, text]) => (
              <div key={label}>
                <dt className="font-mono text-[10px] font-medium tracking-[0.1em] text-fg-3">{label.toUpperCase()}</dt>
                <dd className="leading-normal text-fg-2">{text}</dd>
              </div>
            ))}
          </dl>
          {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-fg-3 underline">Gardyn’s page</a>}
        </details>
      )}
    </div>
  )
}
