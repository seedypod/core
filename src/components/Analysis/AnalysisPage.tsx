import { Download, RefreshCw, Star } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { TimeChart } from '@/src/components/charts/TimeChart'
import { Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, SelectValue, Toggle } from '@/src/components/ds/forms'
import { SettingRow } from '@/src/components/ds/layout'
import { isDemo } from '@/src/demo/mode'
import { fmtStamp } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'

const pct = (v: number) => `${Math.round(v * 100)}%`
const key = (a: { analyzer: string, version: number }) => `${a.analyzer}@${a.version}`
const SLOTS = Array.from({ length: 30 }, (_, i) => ({ value: i + 1, label: `Pod ${i + 1}` }))
/** Each analyser's mark in the legend, the per-pod bars and the chart, in listing order. */
const COLORS = ['var(--meter)', 'var(--pod-ok)', 'var(--pod-ready)', 'var(--pod-attention)']
const colorAt = (i: number) => COLORS[i % COLORS.length] as string
const ROWS = 10

type Listing = inferRouterOutputs<AppRouter>['vision']['analyzers'][number]
type Result = inferRouterOutputs<AppRouter>['vision']['capture'][number]

function Panel({ className, children }: { className?: string, children: ReactNode }) {
  return <div className={cn('flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-5', className)}>{children}</div>
}

/**
 * Capture analysis (ADR-0019): which analysers ran, which one drives pod
 * trends, and how their outputs compare on the same pods and photos.
 */
export function AnalysisPage() {
  const analyzers = trpc.vision.analyzers.useQuery()
  const status = trpc.vision.status.useQuery(undefined, { refetchInterval: 5000 })
  const [exporting, setExporting] = useState(false)
  const st = status.data
  const list = analyzers.data ?? []
  const colorOf = (k: string) => colorAt(Math.max(0, list.findIndex(a => key({ analyzer: a.id, version: a.version }) === k)))

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Analysis</h1>
          <p className="text-[13px] text-fg-2">How leaf cover is measured from camera frames</p>
        </div>
        <Button icon={Download} className="px-3 py-[7px]" onClick={() => setExporting(true)}>Export dataset</Button>
      </div>
      {st && (st.backfill || st.running || st.failed > 0) && (
        <p className="-mt-3 text-[13px] text-fg-2">
          {[
            st.backfill && `Re-running ${st.backfill.analyzer}: ${st.backfill.done} of ${st.backfill.total} captures`,
            st.running && !st.backfill && `Scoring ${st.running}`,
            st.failed > 0 && `${st.failed} capture${st.failed === 1 ? '' : 's'} could not be scored`,
          ].filter(Boolean).join(' · ')}
        </p>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3">
        {list.map((a, i) => <AnalyzerCard key={key({ analyzer: a.id, version: a.version })} a={a} color={colorAt(i)} busy={!!st?.backfill} />)}
      </div>

      <PerPod analyzers={list} colorOf={colorOf} />
      <ComparePod colorOf={colorOf} />

      {exporting && (
        <Modal open onClose={() => setExporting(false)} title="Export a dataset" icon={Download}>
          <DatasetExport />
        </Modal>
      )}
    </div>
  )
}

function AnalyzerCard({ a, color, busy }: { a: Listing, color: string, busy: boolean }) {
  const utils = trpc.useUtils()
  const primary = trpc.vision.setPrimary.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const rerun = trpc.vision.rerun.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const current = a.source === 'device' && a.runsOn.includes('device')
  const canBePrimary = a.metrics.length === 0 || a.metrics.some(m => m.name === 'green_fraction')
  const action = 'flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45'
  return (
    <div className={cn('flex min-w-0 flex-col gap-3 rounded-[14px] border bg-surface p-[18px]', a.primary ? 'border-pod-ok/40' : 'border-line')}>
      <div className="flex items-start gap-2">
        <span className="mt-[9px] h-[3px] w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">{a.label}</span>
          <span className="font-mono text-[11px] text-fg-3">{`${a.id}@${a.version} · ${a.source === 'device' ? 'on device' : 'remote'}`}</span>
        </div>
        {a.primary && <span className="rounded-[10px] bg-pod-ok/15 px-2 py-0.5 font-mono text-[10px] font-medium text-pod-ok">PRIMARY</span>}
      </div>
      <p className="text-[13px] leading-[1.55] text-fg-2 text-pretty">{a.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-2.5">
        <span className="flex-1 font-mono text-[11px] text-fg-3" title={a.lastTs ? `last ${new Date(a.lastTs).toLocaleString()}` : undefined}>
          {a.captures > 0 ? `${a.captures} captures · ${a.rows} results` : 'No results yet'}
        </span>
        {!a.primary && canBePrimary && (
          <button type="button" className={action} disabled={primary.isPending} onClick={() => primary.mutate({ analyzer: a.id })}>
            <Star size={16} />
            Make primary
          </button>
        )}
        {current && (
          <button type="button" className={action} disabled={busy || rerun.isPending} onClick={() => rerun.mutate({ analyzer: a.id, limit: 2000 })}>
            <RefreshCw size={16} />
            Re-run
          </button>
        )}
      </div>
      {(primary.error ?? rerun.error) && <InlineError>{(primary.error ?? rerun.error)?.message}</InlineError>}
    </div>
  )
}

/** Short column head from an analyser id: `exg-otsu` → `OTSU`. */
const head = (k: string) => (k.split('@')[0]?.split('-').at(-1) ?? k).toUpperCase()

/** How the second analyser reads against the first, in percentage points, when they agree on direction. */
export function gapSummary(rows: Result[], columns: string[], labels: Record<string, string>): string | null {
  const [a, b] = columns
  if (!a || !b) return null
  const by = (col: string) => new Map(rows.filter(r => key(r) === col).map(r => [r.slot, r.value]))
  const av = by(a)
  const diffs = [...by(b)].filter(([s]) => av.has(s)).map(([s, v]) => Math.round((v - (av.get(s) as number)) * 100))
  if (!diffs.length) return null
  const lo = Math.min(...diffs)
  const hi = Math.max(...diffs)
  const span = (x: number, y: number) => (x === y ? `${x}` : `${x}–${y}`)
  const [la, lb] = [labels[a] ?? a, labels[b] ?? b]
  if (lo > 0) return `${lb} reads ${span(lo, hi)} points higher than ${la} on every pod.`
  if (hi < 0) return `${lb} reads ${span(-hi, -lo)} points lower than ${la} on every pod.`
  return `${lb} and ${la} differ by up to ${Math.max(-lo, hi)} points.`
}

function PerPod({ analyzers, colorOf }: { analyzers: Listing[], colorOf: (k: string) => string }) {
  const [camera, setCamera] = useState<'upper' | 'lower'>('upper')
  const [all, setAll] = useState(false)
  const list = trpc.camera.list.useQuery({ camera, limit: 1 })
  const pods = trpc.grow.pods.useQuery()
  const frame = list.data?.[0]
  const results = trpc.vision.capture.useQuery({ captureId: frame?.id ?? '' }, { enabled: !!frame })
  const rows = (results.data ?? []).filter(r => r.metric === 'green_fraction')
  const order = analyzers.map(a => key({ analyzer: a.id, version: a.version }))
  // Listing order, so the columns and summary read in the same order as the cards above.
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length)
  const columns = [...new Set(rows.map(key))].sort((a, b) => rank(a) - rank(b))
  const slots = [...new Set(rows.map(r => r.slot))].sort((a, b) => a - b)
  const value = (slot: number, col: string) => rows.find(r => r.slot === slot && key(r) === col)?.value
  const plant = (slot: number) => pods.data?.find(p => p.slot === slot)?.plant ?? '—'
  const labels = Object.fromEntries(analyzers.map(a => [key({ analyzer: a.id, version: a.version }), a.label]))
  const summary = gapSummary(rows, columns, labels)
  const shown = all ? slots : slots.slice(0, ROWS)
  const pick = (c: 'upper' | 'lower') => {
    setCamera(c)
    setAll(false)
  }
  const cell = 'border-b border-grid py-[9px]'
  const th = 'border-b border-line pb-2 font-mono text-[10px] font-normal text-fg-3'

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
            <span className="text-[15px] font-medium">Per pod, latest frame</span>
            {summary && <span className="text-xs text-fg-3">{summary}</span>}
          </div>
          <SegmentedControl ariaLabel="Camera" size="sm" options={[{ value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }]} value={camera} onChange={pick} />
        </div>
        {!frame
          ? <p className="text-[13px] text-fg-2">No photos from this camera yet.</p>
          : columns.length === 0
            ? <p className="text-[13px] text-fg-2">This photo hasn&apos;t been scored yet.</p>
            : (
                <div className="overflow-x-auto">
                  <table className="w-full table-fixed border-collapse text-left text-[13px]">
                    <thead>
                      <tr>
                        <th className={cn(th, 'w-9')}>POD</th>
                        <th className={cn(th, 'w-[30%] pl-3.5')}>PLANT</th>
                        <th className={cn(th, 'pl-3.5')}>LEAF COVER</th>
                        {columns.map(c => <th key={c} title={c} className={cn(th, 'w-[84px] pl-3.5 text-right')}>{head(c)}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((s) => {
                        const vals = columns.map(c => value(s, c)).filter((v): v is number => v !== undefined)
                        const lo = Math.min(...vals)
                        const hi = Math.max(...vals)
                        return (
                          <tr key={s}>
                            <td className={cn(cell, 'font-mono text-xs text-fg-3')}>{s}</td>
                            <td className={cn(cell, 'max-w-0 truncate pl-3.5')}>{plant(s)}</td>
                            <td className={cn(cell, 'pl-3.5')}>
                              <div className="relative h-2.5">
                                <span className="absolute inset-x-0 top-0.5 h-1.5 rounded-[3px] bg-active" />
                                <span className="absolute top-0.5 h-1.5 rounded-[3px] bg-line-2" style={{ left: pct(lo), width: pct(hi - lo) }} />
                                {columns.map((c) => {
                                  const v = value(s, c)
                                  return v === undefined ? null : <span key={c} className="absolute top-0 h-2.5 w-0.5" style={{ left: pct(Math.min(1, v)), background: colorOf(c) }} />
                                })}
                              </div>
                            </td>
                            {columns.map((c, ci) => {
                              const v = value(s, c)
                              return <td key={c} className={cn(cell, 'pl-3.5 text-right font-mono text-xs')} style={ci > 0 ? { color: colorOf(c) } : undefined}>{v === undefined ? '—' : pct(v)}</td>
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
        {slots.length > ROWS && (
          <button type="button" className="cursor-pointer self-start border-0 bg-transparent p-0 text-[13px] text-fg-2 hover:text-fg" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${slots.length} pods`}
          </button>
        )}
      </Panel>

      {frame && (
        <Panel className="gap-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-[15px] font-medium">Latest photo</span>
            <span className="font-mono text-[11px] text-fg-3">{`${camera} · ${fmtStamp(frame.ts)}`}</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="aspect-[16/10] overflow-hidden rounded-[10px] bg-code">
                <img src={frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`} alt={`${camera} camera at ${frame.ts}`} className="size-full object-cover" />
              </div>
              <span className="text-xs text-fg-3">Original</span>
            </div>
          </div>
        </Panel>
      )}
    </>
  )
}

function ComparePod({ colorOf }: { colorOf: (k: string) => string }) {
  const [slot, setSlot] = useState(1)
  const cmp = trpc.vision.compare.useQuery({ slot, metric: 'green_fraction', limit: 200 })
  const series = (cmp.data ?? []).map(s => ({ name: key(s), color: colorOf(key(s)), points: s.points.map(p => ({ x: Date.parse(p.ts), y: p.value })) }))
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[15px] font-medium">One pod over time</span>
        <SelectValue label="Pod" value={slot} options={SLOTS} onChange={setSlot} />
      </div>
      <TimeChart series={series} height={180} yMin={0} yMax={1} formatY={pct} formatX={x => new Date(x).toLocaleDateString()} />
      {series.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {cmp.data?.map(s => (
            <span key={key(s)} className="text-fg-2">
              {`${key(s)} `}
              <span className="font-mono text-fg">{pct(s.points.at(-1)?.value ?? 0)}</span>
            </span>
          ))}
        </div>
      )}
    </Panel>
  )
}

const WINDOWS = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const
const mb = (b: number) => `${(b / 1_000_000).toFixed(b < 10_000_000 ? 1 : 0)} MB`

/** Export the photos, results, pods and telemetry for off-device analysis or training (ADR-0019 phase 2). */
function DatasetExport() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [images, setImages] = useState(true)
  const [to] = useState(() => new Date())
  const from = new Date(to.getTime() - Number(days) * 86_400_000).toISOString()
  const summary = trpc.datasets.summary.useQuery({ from, to: to.toISOString(), images })
  const s = summary.data
  const href = `${apiBase()}/api/datasets/export?${new URLSearchParams({ from, to: to.toISOString(), images: images ? '1' : '0' }).toString()}`
  return (
    <div className="flex flex-col">
      <p className="text-[13px] text-fg-2">Photos, every analyser&apos;s results, pods and sensor history as a tar.</p>
      <SettingRow label="Window"><SegmentedControl ariaLabel="Window" size="sm" options={WINDOWS} value={days} onChange={setDays} /></SettingRow>
      <SettingRow label="Include photos" sub="The bulk of the size" divider={false}><Toggle label="Include photos" on={images} onChange={setImages} /></SettingRow>
      {s && <p className="mt-2 font-mono text-[12px] text-fg-3">{`${s.captures} photos · ${s.analyses} results · ${s.telemetry} readings${images ? ` · about ${mb(s.imageBytes)}` : ''}`}</p>}
      <div className="mt-3">
        {isDemo()
          ? <p className="text-[13px] text-fg-2">Downloads need a real unit; the demo has no server.</p>
          : <a href={href} download className="inline-flex"><Button size="sm" icon={Download} tabIndex={-1}>Download</Button></a>}
      </div>
    </div>
  )
}
