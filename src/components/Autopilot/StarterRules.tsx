import type { inferRouterOutputs } from '@trpc/server'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/src/components/ds/core'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { fromRule, type Draft } from './builderModel'

export type Starter = inferRouterOutputs<AppRouter>['care']['starterRules'][number]

/**
 * Starter rules from the knowledge bundle (ADR-0029). Each opens in the
 * builder, saves in dry-run like any new rule, and is armed by hand from its
 * row. Hidden once every one the unit can run is added.
 */
export function StarterRules({ onOpen }: { onOpen: (draft: Draft) => void }) {
  const starters = trpc.care.starterRules.useQuery()
  const list = starters.data ?? []
  if (!list.some(s => !s.added && !s.unavailable)) return null
  return (
    <section className="flex flex-col gap-2.5" aria-label="Starter rules">
      <SectionLabel>Starter rules</SectionLabel>
      <p className="text-[13px] text-fg-2">From the knowledge bundle. Each one only notifies you, starts in dry run, and links the note its threshold comes from.</p>
      <div className="grid gap-2.5 min-[720px]:grid-cols-3">
        {list.map((s) => {
          const draft = fromRule(s.rule)
          const off = s.added || !!s.unavailable || !draft
          return (
            <div key={s.id} data-testid={`starter-${s.id}`} className={cn('flex flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3.5', off && 'opacity-60')}>
              <button
                type="button"
                disabled={off}
                onClick={() => draft && onOpen(draft)}
                className="flex cursor-pointer flex-col gap-1.5 border-0 bg-transparent p-0 text-left disabled:cursor-default"
              >
                <span className="text-sm font-medium text-fg">{s.title}</span>
                <span className="text-[13px] leading-snug text-fg-2">{s.description}</span>
              </button>
              {(s.added || s.unavailable) && <span className="font-mono text-[11px] text-fg-3">{s.added ? 'added' : s.unavailable}</span>}
              <span className="flex flex-wrap gap-x-3 text-[12px] text-fg-3">
                {s.citations.map(c => (
                  <a key={c.url} href={c.url} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">{c.section}</a>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
