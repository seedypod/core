import { Download, RefreshCw, ScanEye, Star } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { LineChart } from '@/src/components/charts/LineChart'
import { Badge, Button, Card, CardHeader, InlineError, SectionLabel } from '@/src/components/ds/core'
import { SegmentedControl, SelectValue, Toggle } from '@/src/components/ds/forms'
import { PageHeader, SettingRow } from '@/src/components/ds/layout'
import { isDemo } from '@/src/demo/link'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'

const pct = (v: number) => `${Math.round(v * 100)}%`
const key = (a: { analyzer: string, version: number }) => `${a.analyzer}@${a.version}`
const SLOTS = Array.from({ length: 30 }, (_, i) => ({ value: i + 1, label: `Pod ${i + 1}` }))

/**
 * Capture analysis (ADR-0019): which analysers ran, which one drives pod
 * trends, and how their outputs compare on the same pods and photos.
 */
export function AnalysisPage() {
  const analyzers = trpc.vision.analyzers.useQuery()
  const status = trpc.vision.status.useQuery(undefined, { refetchInterval: 5000 })
  const [slot, setSlot] = useState(1)
  const [camera, setCamera] = useState<'upper' | 'lower'>('upper')
  const st = status.data

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Analysis" />
      {st && (st.backfill || st.running || st.failed > 0) && (
        <p className="text-[13px] text-fg-2">
          {[
            st.backfill && `Re-running ${st.backfill.analyzer}: ${st.backfill.done} of ${st.backfill.total} captures`,
            st.running && !st.backfill && `Scoring ${st.running}`,
            st.failed > 0 && `${st.failed} capture${st.failed === 1 ? '' : 's'} could not be scored`,
          ].filter(Boolean).join(' · ')}
        </p>
      )}

      <SectionLabel>Analysers</SectionLabel>
      {analyzers.data?.map(a => <AnalyzerCard key={key({ analyzer: a.id, version: a.version })} a={a} busy={!!st?.backfill} />)}

      <SectionLabel right={<SelectValue label="Pod" value={slot} options={SLOTS} onChange={setSlot} />}>Compare on one pod</SectionLabel>
      <ComparePod slot={slot} />

      <SectionLabel right={<SegmentedControl ariaLabel="Camera" size="sm" options={[{ value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }]} value={camera} onChange={setCamera} />}>Latest photo, side by side</SectionLabel>
      <LatestCapture camera={camera} />

      <SectionLabel>Dataset</SectionLabel>
      <DatasetCard />
    </div>
  )
}

type Listing = inferRouterOutputs<AppRouter>['vision']['analyzers'][number]

function AnalyzerCard({ a, busy }: { a: Listing, busy: boolean }) {
  const utils = trpc.useUtils()
  const primary = trpc.vision.setPrimary.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const rerun = trpc.vision.rerun.useMutation({ onSuccess: () => utils.vision.invalidate() })
  const current = a.source === 'device' && a.runsOn.includes('device')
  const canBePrimary = a.metrics.length === 0 || a.metrics.some(m => m.name === 'green_fraction')
  return (
    <Card>
      <CardHeader
        title={a.label}
        subtitle={`${a.id}@${a.version}`}
        icon={ScanEye}
        right={(
          <div className="flex items-center gap-2">
            {a.primary && <Badge variant="active">Primary</Badge>}
            <Badge variant="dev">{a.source === 'device' ? 'On device' : 'Remote'}</Badge>
          </div>
        )}
      />
      <p className="mt-2 text-[13px] text-fg-2">{a.description}</p>
      <div className="mt-2 font-mono text-[12px] text-fg-3">
        {a.captures > 0 ? `${a.captures} captures · ${a.rows} results · last ${new Date(a.lastTs ?? 0).toLocaleString()}` : 'No results yet'}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {!a.primary && canBePrimary && <Button size="sm" icon={Star} disabled={primary.isPending} onClick={() => primary.mutate({ analyzer: a.id })}>Make primary</Button>}
        {current && <Button size="sm" icon={RefreshCw} disabled={busy || rerun.isPending} onClick={() => rerun.mutate({ analyzer: a.id, limit: 2000 })}>Re-run on stored photos</Button>}
      </div>
      {(primary.error ?? rerun.error) && <InlineError className="mt-2">{(primary.error ?? rerun.error)?.message}</InlineError>}
    </Card>
  )
}

function ComparePod({ slot }: { slot: number }) {
  const cmp = trpc.vision.compare.useQuery({ slot, metric: 'green_fraction', limit: 200 })
  const series = (cmp.data ?? []).map(s => ({ name: key(s), points: s.points.map(p => ({ x: Date.parse(p.ts), y: p.value })) }))
  return (
    <Card>
      <LineChart series={series} height={180} yMin={0} yMax={1} formatY={pct} formatX={x => new Date(x).toLocaleDateString()} />
      {series.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {cmp.data?.map(s => (
            <span key={key(s)} className="text-fg-2">
              {`${key(s)} `}
              <span className="font-mono text-fg">{pct(s.points.at(-1)?.value ?? 0)}</span>
            </span>
          ))}
        </div>
      )}
    </Card>
  )
}

function LatestCapture({ camera }: { camera: 'upper' | 'lower' }) {
  const list = trpc.camera.list.useQuery({ camera, limit: 1 })
  const frame = list.data?.[0]
  const results = trpc.vision.capture.useQuery({ captureId: frame?.id ?? '' }, { enabled: !!frame })
  if (!frame) return <Card dashed><p className="text-[13px] text-fg-2">No photos from this camera yet.</p></Card>
  const rows = (results.data ?? []).filter(r => r.metric === 'green_fraction')
  const columns = [...new Set(rows.map(key))]
  const slots = [...new Set(rows.map(r => r.slot))].sort((a, b) => a - b)
  const value = (slot: number, col: string) => rows.find(r => r.slot === slot && key(r) === col)?.value
  const src = frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`
  return (
    <Card>
      <CardHeader title={new Date(frame.ts).toLocaleString()} subtitle={frame.id} />
      <div className="mt-3 aspect-[12/5] w-full overflow-hidden rounded-[var(--radius-ctl)] bg-code">
        <img src={src} alt={`${camera} camera at ${frame.ts}`} className="h-full w-full object-cover" />
      </div>
      {columns.length === 0
        ? <p className="mt-3 text-[13px] text-fg-2">This photo hasn&apos;t been scored yet.</p>
        : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="text-fg-3">
                  <tr>
                    <th className="py-1 pr-4 font-normal">Pod</th>
                    {columns.map(c => <th key={c} className="py-1 pr-4 font-mono font-normal">{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {slots.map(s => (
                    <tr key={s} className="border-t border-line">
                      <td className="py-1 pr-4 text-fg-2">{s}</td>
                      {columns.map(c => <td key={c} className="py-1 pr-4 font-mono">{value(s, c) === undefined ? '—' : pct(value(s, c) as number)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </Card>
  )
}

const WINDOWS = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const
const mb = (b: number) => `${(b / 1_000_000).toFixed(b < 10_000_000 ? 1 : 0)} MB`

/** Export the photos, results, pods and telemetry for off-device analysis or training (ADR-0019 phase 2). */
function DatasetCard() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [images, setImages] = useState(true)
  const [to] = useState(() => new Date())
  const from = new Date(to.getTime() - Number(days) * 86_400_000).toISOString()
  const summary = trpc.datasets.summary.useQuery({ from, to: to.toISOString(), images })
  const s = summary.data
  const href = `${apiBase()}/api/datasets/export?${new URLSearchParams({ from, to: to.toISOString(), images: images ? '1' : '0' }).toString()}`
  return (
    <Card>
      <CardHeader title="Export a dataset" subtitle="Photos, every analyser's results, pods and sensor history as a tar" icon={Download} />
      <SettingRow label="Window"><SegmentedControl ariaLabel="Window" size="sm" options={WINDOWS} value={days} onChange={setDays} /></SettingRow>
      <SettingRow label="Include photos" sub="The bulk of the size" divider={false}><Toggle label="Include photos" on={images} onChange={setImages} /></SettingRow>
      {s && <p className="mt-2 font-mono text-[12px] text-fg-3">{`${s.captures} photos · ${s.analyses} results · ${s.telemetry} readings${images ? ` · about ${mb(s.imageBytes)}` : ''}`}</p>}
      <div className="mt-3">
        {isDemo()
          ? <p className="text-[13px] text-fg-2">Downloads need a real unit; the demo has no server.</p>
          : <a href={href} download className="inline-flex"><Button size="sm" icon={Download} tabIndex={-1}>Download</Button></a>}
      </div>
    </Card>
  )
}
