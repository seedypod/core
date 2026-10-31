import { Droplets, Waves, Zap } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, InlineError, Metric, SectionLabel, StatusDot } from '@/src/components/ds/core'
import { SegmentedControl } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { fmtDay, LineChart } from '@/src/components/charts/LineChart'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { trpc } from '@/src/utils/trpc'

const DURATIONS = [{ value: '60', label: '1 min' }, { value: '300', label: '5 min' }, { value: '600', label: '10 min' }, { value: '900', label: '15 min' }] as const

export function WaterPage() {
  const utils = trpc.useUtils()
  const pump = trpc.pump.get.useQuery()
  const sensors = trpc.sensors.latest.useQuery()
  const system = trpc.system.info.useQuery()
  const level = trpc.telemetry.history.useQuery({ sensor: 'water_level_pct', hours: 24 * 7, maxPoints: 300 })
  const power = trpc.telemetry.history.useQuery({ sensor: 'pump_w', hours: 24 * 7, maxPoints: 300 })
  const runs = trpc.schedules.recentRuns.useQuery()
  const runOnce = trpc.pump.runOnce.useMutation({ onSuccess: () => utils.pump.invalidate() })
  const stop = trpc.pump.stop.useMutation({ onSuccess: () => utils.pump.invalidate() })
  const [dur, setDur] = useState<typeof DURATIONS[number]['value']>('300')
  const p = pump.data
  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const limits = system.data?.system?.limits
  const tank = s.water_level_pct?.value

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Water" />
      <Card tone={p?.fault ? 'danger' : undefined}>
        <CardHeader
          title={tank === undefined ? '…' : `${tank}% full`}
          subtitle={p ? (p.on ? `pump running at ${p.level}% · ${p.remainingS ?? '—'}s left` : p.fault ? `pump fault: ${p.fault} — acknowledge in Alerts after fixing` : 'pump idle') : '…'}
          icon={Droplets}
          right={<StatusDot tone={p?.fault ? 'danger' : p?.on ? 'ok' : 'muted'} label={p?.fault ? 'fault' : p?.on ? 'running' : 'idle'} />}
        />
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-field">
          <div className="h-full rounded-full bg-water transition-[width] duration-700" style={{ width: `${tank ?? 0}%` }} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SegmentedControl value={dur} onChange={setDur} options={DURATIONS.map(d => ({ value: d.value, label: d.label }))} />
          <Button variant="primary" disabled={!!p?.on || !!p?.fault} onClick={() => runOnce.mutate({ durationS: Number(dur) })}>Run pump</Button>
          <Button disabled={!p?.on} onClick={() => stop.mutate()}>Stop</Button>
        </div>
        {runOnce.error && <InlineError className="mt-2">{runOnce.error.message}</InlineError>}
        {limits && (
          <p className="mt-2 text-[12px] text-fg-3">
            Hardware limits: max run
            {limits.pumpMaxRunS}
            s · max duty
            {limits.pumpMaxDuty}
            % · low-water refuse at
            {limits.waterLowCm ?? '—'}
            {' '}
            cm.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 min-[600px]:grid-cols-4">
        <Metric label="Distance" value={fmt(s.water_distance)} icon={Waves} />
        <Metric label="Pump power" value={fmt(s.pump_w)} icon={Zap} />
        <Metric label="Pump current" value={fmt(s.pump_a)} icon={Zap} />
        <Metric label="Supply" value={fmt(s.pump_v)} icon={Zap} />
      </div>

      <SectionLabel>Tank level, 7 days</SectionLabel>
      <Card><LineChart height={160} yMin={0} yMax={100} fill formatX={fmtDay} formatY={y => `${Math.round(y)}%`} series={[{ name: 'Tank', color: 'var(--accent-water)', points: (level.data ?? []).map(p => ({ x: Date.parse(p.ts), y: p.value })) }]} /></Card>
      <SectionLabel>Pump power, 7 days</SectionLabel>
      <Card><LineChart height={120} yMin={0} formatX={fmtDay} formatY={y => `${y.toFixed(1)} W`} series={[{ name: 'Pump W', color: 'var(--status-ok)', points: (power.data ?? []).map(p => ({ x: Date.parse(p.ts), y: p.value })) }]} /></Card>

      <SectionLabel>Recent scheduled runs</SectionLabel>
      <Card>
        {(runs.data ?? []).length === 0 && <p className="text-[13px] text-fg-3">No scheduled runs yet.</p>}
        {(runs.data ?? []).slice(0, 10).map(r => (
          <div key={r.key} className="flex items-center justify-between border-b border-line py-2 text-[13px] last:border-0">
            <span className="text-fg-2">{r.scheduleId}</span>
            <span className="font-mono text-fg-3">{new Date(r.firedAt).toLocaleString()}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}

function fmt(r: { value: number, unit: string } | undefined): string {
  return r ? `${r.value}${r.unit.startsWith('°') || r.unit === '%' ? r.unit : ` ${r.unit}`}` : '—'
}
