import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type Listing = inferRouterOutputs<AppRouter>['vision']['analyzers'][number]

const key = (a: { analyzer: string, version: number }) => `${a.analyzer}@${a.version}`

/**
 * How often each analyser version agrees with the grower's labels, so the
 * labels given in Teach answer which version is right, not only whether the
 * versions differ. A version with nothing scored on a labelled pod shows a dash.
 */
export function Agreement({ analyzers, colorOf }: { analyzers: Listing[], colorOf: (k: string) => string }) {
  const data = trpc.vision.agreement.useQuery().data
  const pods = data?.pods ?? 0
  const scored = (k: string) => data?.analyzers.find(a => key(a) === k && a.total > 0)
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-baseline gap-2 pb-1.5">
        <span className="flex-1 text-[15px] font-medium">Agreement with labels</span>
        {data && <span className="font-mono text-[11px] text-fg-3">{`${pods} labelled pod${pods === 1 ? '' : 's'}`}</span>}
      </div>
      {pods === 0
        ? <p className="text-[13px] text-fg-2">No labelled pods yet. Label pods in Teach and each method is scored against them.</p>
        : analyzers.map((a) => {
            const k = key({ analyzer: a.id, version: a.version })
            const s = scored(k)
            const share = s ? s.agree / s.total : 0
            return (
              <div key={k} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.5rem] items-center gap-2.5 border-t border-line py-1.5">
                <span className="truncate font-mono text-xs">{k}</span>
                <span
                  role="img"
                  aria-label={s ? `${k} agrees with labels on ${Math.round(share * 100)}% of ${s.total} pods` : `${k} has no readings on labelled pods`}
                  className="relative h-1.5 rounded-[3px] bg-line"
                >
                  {s && <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${share * 100}%`, background: colorOf(k) }} />}
                </span>
                <span className="text-right font-mono text-xs">{s ? `${Math.round(share * 100)}%` : '—'}</span>
              </div>
            )
          })}
      <p className="pt-1.5 text-xs leading-normal text-fg-3 text-pretty">
        A reading agrees when an empty or seeded pod reads under 2% and a sprouted, growing or ready pod reads 2% or more. Unhealthy pods are left out. Pod state agrees when its class is the label, seeded counting as empty.
      </p>
    </div>
  )
}
