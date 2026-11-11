import { cn } from '@/lib/utils'
import { Chart3D, ChartNote, LoadingLine, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { podsData, type PodsData } from '@/src/components/charts/viz3d/shape'
import { towerShape } from '@/src/components/Grow/towerLayout'
import { fmtStamp } from '@/src/lib/timeAgo'
import { trpc } from '@/src/utils/trpc'

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Without WebGL: each tower's pods as a column of bars, an empty or unmeasured pod a dash. */
function CoverBars({ data }: { data: PodsData | null }) {
  if (!data) return null
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-4" data-testid="leaf-cover-flat">
      {data.towers.map(t => (
        <div key={t.label} className="flex flex-col gap-1">
          <div className="font-mono text-[10px] font-medium tracking-[0.1em] text-fg-3">{t.label.toUpperCase()}</div>
          {t.pods.map((v, k) => (
            <div key={k} className="flex items-center gap-2 font-mono text-[11px] text-fg-3">
              <span className="relative h-1.5 flex-1 rounded-[3px] bg-active">
                {v !== null && <span className="absolute inset-y-0 left-0 rounded-[3px] bg-pod-ok" style={{ width: pct(v) }} />}
              </span>
              <span className={cn('w-8 text-right', v !== null && 'text-fg')}>{v === null ? '—' : pct(v)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Leaf cover per pod from the primary analyser, tower by tower; empty pods stay grey. */
export function LeafCover({ capturedAt }: { capturedAt: string | null }) {
  const pods = trpc.grow.pods.useQuery()
  const trends = trpc.vision.podTrends.useQuery()
  const queries = [pods, trends]
  const all = pods.data ?? []
  const green = new Map((trends.data ?? []).map(t => [t.slot, t.green]))
  const rows = all.map(p => ({ slot: p.slot, empty: p.status === 'empty', cover: green.get(p.slot) ?? null }))
  const measured = rows.filter(r => !r.empty && r.cover !== null).length
  const status = vizStatus(queries, all.length === 0)
  const scene = all.length ? podsData(rows, towerShape(all.length).columns) : null
  return (
    <section aria-label="Leaf cover per pod" className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-[15px] font-medium">Leaf cover per pod</span>
        <span className="min-w-[180px] flex-1 text-xs text-fg-3">
          {status === 'loading'
            ? <LoadingLine />
            : `${measured} of ${all.length} pods measured${capturedAt ? ` · photo ${fmtStamp(capturedAt)}` : ''}`}
        </span>
        <ChartNote status={status} stale={staleSince(queries)} onRetry={() => queries.forEach(q => void q.refetch?.())} />
      </div>
      <Chart3D
        kind="pods"
        data={status === 'ready' ? scene : null}
        status={status}
        label={`Leaf cover per pod: ${measured} of ${all.length} measured`}
        message={status === 'error' ? 'Couldn\'t load the pods.' : 'No pods yet.'}
        fallback={<CoverBars data={scene} />}
      />
    </section>
  )
}
