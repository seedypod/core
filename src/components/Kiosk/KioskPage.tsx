import { useEffect, useState } from 'react'
import { LineChart, SensorAge } from '@/src/components/ds/charts'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { formatReading, SENSOR_META } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'

/** A reading older than this dims its tile, so a wall display never shows a stale number as current. */
const STALE_MS = 5 * 60_000
const day = { hours: 24, maxPoints: 96 }

/** Wall-display mode: big numbers, dark, no shell. Route: /kiosk */
export function KioskPage() {
  const sensors = trpc.sensors.latest.useQuery(undefined, { refetchInterval: 10_000 })
  const light = trpc.light.get.useQuery(undefined, { refetchInterval: 10_000 })
  const pump = trpc.pump.get.useQuery(undefined, { refetchInterval: 5_000 })
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true }, { refetchInterval: 10_000 })
  const system = trpc.system.info.useQuery(undefined, { refetchInterval: 60_000 })
  const hourly = { refetchInterval: 15 * 60_000 }
  const tankH = trpc.telemetry.history.useQuery({ sensor: 'water_level_pct', ...day }, hourly)
  const airH = trpc.telemetry.history.useQuery({ sensor: 'air_temp', ...day }, hourly)
  const humH = trpc.telemetry.history.useQuery({ sensor: 'humidity', ...day }, hourly)
  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const tiles: Array<{ label: string, value: string, reading?: Reading, spark?: number[], color?: string }> = [
    { label: 'Tank', value: s.water_level_pct ? `${s.water_level_pct.value}%` : '—', reading: s.water_level_pct, spark: tankH.data?.map(p => p.value), color: SENSOR_META.water_level_pct.color },
    { label: 'Air', value: s.air_temp ? `${s.air_temp.value}°` : '—', reading: s.air_temp, spark: airH.data?.map(p => p.value), color: SENSOR_META.air_temp.color },
    { label: 'Humidity', value: s.humidity ? `${s.humidity.value}%` : '—', reading: s.humidity, spark: humH.data?.map(p => p.value), color: SENSOR_META.humidity.color },
    { label: 'Light', value: light.data?.on ? `${light.data.level}%` : 'off' },
    { label: 'Pump', value: pump.data?.on ? `${pump.data.remainingS ?? ''}s` : pump.data?.fault ? 'FAULT' : 'idle' },
    ...(system.data?.system?.caps.sensors ?? [])
      .filter(id => SENSOR_META[id].group === 'water-quality')
      .map(id => ({ label: SENSOR_META[id].label, value: formatReading(s[id]), reading: s[id] })),
  ]
  return (
    <div className="min-h-dvh bg-app p-8 text-fg">
      <div className="grid grid-cols-2 gap-6 min-[900px]:grid-cols-5">
        {tiles.map((t) => {
          const stale = t.reading ? now - Date.parse(t.reading.ts) > STALE_MS : false
          return (
            <div key={t.label} data-stale={stale || undefined} className={`flex flex-col rounded-[var(--radius-card)] border border-line bg-surface p-6 ${stale ? 'opacity-50' : ''}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] uppercase tracking-wide text-fg-3">{t.label}</span>
                {t.reading && <SensorAge timestamp={t.reading.ts} className="text-[12px]" />}
              </div>
              <div className="mt-2 font-mono text-[56px] leading-none">{t.value}</div>
              {t.spark && t.spark.length > 1 && t.color && <div className="mt-4"><LineChart series={[{ data: t.spark, color: t.color, fill: true }]} height={36} /></div>}
            </div>
          )
        })}
      </div>
      {(alerts.data ?? []).length > 0 && (
        <div className="mt-8 rounded-[var(--radius-card)] border border-warn-line bg-warn-bg p-6 text-[24px]">
          {(alerts.data ?? []).map(a => (
            <div key={a.id}>
              {a.kind.replace(/_/g, ' ')}
              {' '}
              —
              {' '}
              {a.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
