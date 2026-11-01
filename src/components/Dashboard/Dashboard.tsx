import { Droplets, Sun, Thermometer, Waves, Zap } from 'lucide-react'
import { useState } from 'react'
import { TowerHome } from './TowerHome'
import { Card, CardHeader, GrowBackdrop, InlineError, Metric, SectionLabel, StatusDot } from '@/src/components/ds/core'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { formatReading, SENSOR_META } from '@/src/lib/sensorMeta'
import { Welcome } from '@/src/components/Welcome/Welcome'
import { trpc } from '@/src/utils/trpc'

function minutesNow(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

export function Dashboard() {
  const settings = trpc.settings.get.useQuery()
  const [noWebGL, setNoWebGL] = useState(false)
  // A fresh database opens on Welcome (ADR-0021) until the owner starts a garden or restores one.
  if (settings.data && !settings.data.setupComplete) return <Welcome />
  // The tower is Home; without WebGL the cards stand in for it.
  return noWebGL ? <CardsHome /> : <TowerHome onUnavailable={() => setNoWebGL(true)} />
}

/** Home without WebGL: the light, water and environment as cards. */
export function CardsHome() {
  const sensors = trpc.sensors.latest.useQuery()
  const lightState = trpc.light.get.useQuery()
  const pumpState = trpc.pump.get.useQuery()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const system = trpc.system.info.useQuery()
  const setLight = trpc.light.set.useMutation({ onSuccess: () => lightState.refetch() })
  const runPump = trpc.pump.runOnce.useMutation({ onSuccess: () => pumpState.refetch() })
  const stopPump = trpc.pump.stop.useMutation({ onSuccess: () => pumpState.refetch() })

  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const l = lightState.data
  const p = pumpState.data
  const active = (alerts.data ?? []).filter(a => a.active)
  const quality = (system.data?.system?.caps.sensors ?? []).filter(id => SENSOR_META[id].group === 'water-quality')

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      {active.length > 0 && (
        <Card tone="warn">
          <CardHeader title={`${active.length} alert${active.length > 1 ? 's' : ''}`} subtitle={active.map(a => `${a.kind}: ${a.detail}`).join(' · ')} />
        </Card>
      )}

      <Card backdrop={<GrowBackdrop brightness={l?.on ? l.level : null} minutes={minutesNow()} off={!l?.on} />}>
        <CardHeader
          title="Grow light"
          subtitle={l ? (l.on ? `${l.level}% since ${new Date(l.since).toLocaleTimeString()}` : 'off') : '…'}
          icon={Sun}
          right={<StatusDot tone={l?.on ? 'ok' : 'muted'} label={l?.on ? 'on' : 'off'} />}
        />
        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            value={l?.level ?? 0}
            onChange={e => setLight.mutate({ level: Number(e.target.value) })}
            className="flex-1 accent-[var(--accent-light)]"
            aria-label="Brightness"
          />
          <button type="button" className="lp-btn" onClick={() => setLight.mutate({ on: !l?.on })}>{l?.on ? 'Turn off' : 'Turn on'}</button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Water"
          subtitle={p ? (p.on ? `pump ${p.level}% · ${p.remainingS ?? '∞'}s left` : p.fault ? `fault: ${p.fault}` : 'pump idle') : '…'}
          icon={Droplets}
          right={<StatusDot tone={p?.fault ? 'danger' : p?.on ? 'ok' : 'muted'} label={p?.fault ? 'fault' : p?.on ? 'running' : 'idle'} />}
        />
        <div className="mt-3 grid grid-cols-2 gap-3 min-[600px]:grid-cols-4">
          <Metric label="Tank" value={fmt(s.water_level_pct)} icon={Waves} />
          <Metric label="Distance" value={fmt(s.water_distance)} icon={Droplets} />
          <Metric label="Pump power" value={fmt(s.pump_w)} icon={Zap} />
          <Metric label="Pump current" value={fmt(s.pump_a)} icon={Zap} />
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" className="lp-btn" disabled={!!p?.on} onClick={() => runPump.mutate({ durationS: 300 })}>Run 5 min</button>
          <button type="button" className="lp-btn" disabled={!p?.on} onClick={() => stopPump.mutate()}>Stop</button>
        </div>
        {runPump.error && <InlineError>{runPump.error.message}</InlineError>}
      </Card>

      {quality.length > 0 && (
        <>
          <SectionLabel>Water quality</SectionLabel>
          <div className="grid grid-cols-2 gap-3 min-[600px]:grid-cols-3">
            {quality.map(id => <Metric key={id} label={SENSOR_META[id].label} value={formatReading(s[id])} icon={SENSOR_META[id].icon} />)}
          </div>
        </>
      )}

      <SectionLabel>Environment</SectionLabel>
      <div className="grid grid-cols-2 gap-3 min-[600px]:grid-cols-3">
        <Metric label="Air" value={fmt(s.air_temp)} icon={Thermometer} />
        <Metric label="Humidity" value={fmt(s.humidity)} icon={Droplets} />
        <Metric label="Board" value={fmt(s.pcb_temp)} icon={Thermometer} />
      </div>
    </div>
  )
}

function fmt(r: { value: number, unit: string } | undefined): string {
  return r ? `${r.value}${r.unit.startsWith('°') ? r.unit : ` ${r.unit}`}` : '—'
}
