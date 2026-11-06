import { Droplets, Sun, Thermometer, Waves, Zap } from 'lucide-react'
import { useState } from 'react'
import { TowerHome } from './TowerHome'
import { ReadingAge } from '@/src/components/Sensors/ReadingAge'
import { Card, CardHeader, GrowBackdrop, InlineError, Metric, SectionLabel, StatusDot } from '@/src/components/ds/core'
import { Slider } from '@/src/components/ds/forms'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { formatReading, SENSOR_META, withUnit } from '@/src/lib/sensorMeta'
import { useLightControl } from '@/src/components/Light/useLightControl'
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
  const { light: l, level, requested, lightOn, preview, commit, power } = useLightControl()
  const pumpState = trpc.pump.get.useQuery()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const system = trpc.system.info.useQuery()
  const utils = trpc.useUtils()
  const runPump = trpc.pump.runOnce.useMutation({ onSuccess: () => utils.pump.invalidate() })
  const stopPump = trpc.pump.stop.useMutation({ onSuccess: () => utils.pump.invalidate() })

  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
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
          subtitle={l ? (l.on || requested ? `${level}% since ${new Date(l.since).toLocaleTimeString()}` : 'off') : '…'}
          icon={Sun}
          right={<StatusDot tone={l?.on ? 'ok' : 'muted'} label={l?.on ? 'on' : 'off'} />}
        />
        <div className="mt-3 flex items-center gap-3">
          <Slider
            value={level}
            onChange={preview}
            onCommit={commit}
            label="Brightness"
          />
          <button type="button" className="lp-btn" onClick={() => power(!lightOn)}>{lightOn ? 'Turn off' : 'Turn on'}</button>
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
          <Metric label="Tank" value={fmt(s.water_level_pct)} icon={Waves} note={<ReadingAge readings={[s.water_level_pct]} />} />
          <Metric label="Distance" value={fmt(s.water_distance)} icon={Droplets} note={<ReadingAge readings={[s.water_distance]} />} />
          <Metric label="Pump power" value={fmt(s.pump_w)} icon={Zap} note={<ReadingAge readings={[s.pump_w]} />} />
          <Metric label="Pump current" value={fmt(s.pump_a)} icon={Zap} note={<ReadingAge readings={[s.pump_a]} />} />
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
            {quality.map(id => <Metric key={id} label={SENSOR_META[id].label} value={formatReading(s[id])} icon={SENSOR_META[id].icon} note={<ReadingAge readings={[s[id]]} />} />)}
          </div>
        </>
      )}

      <SectionLabel>Environment</SectionLabel>
      <div className="grid grid-cols-2 gap-3 min-[600px]:grid-cols-3">
        <Metric label="Air" value={fmt(s.air_temp)} icon={Thermometer} note={<ReadingAge readings={[s.air_temp]} />} />
        <Metric label="Humidity" value={fmt(s.humidity)} icon={Droplets} note={<ReadingAge readings={[s.humidity]} />} />
        <Metric label="Board" value={fmt(s.pcb_temp)} icon={Thermometer} note={<ReadingAge readings={[s.pcb_temp]} />} />
      </div>
    </div>
  )
}

function fmt(r: { value: number, unit: string } | undefined): string {
  return r ? withUnit(r.value, r.unit) : '—'
}
