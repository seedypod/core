import type { Reading, SensorId } from '@/src/hardware/contract'
import { formatReading, SENSOR_META } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'

/** Wall-display mode: big numbers, dark, no shell. Route: /kiosk */
export function KioskPage() {
  const sensors = trpc.sensors.latest.useQuery(undefined, { refetchInterval: 10_000 })
  const light = trpc.light.get.useQuery(undefined, { refetchInterval: 10_000 })
  const pump = trpc.pump.get.useQuery(undefined, { refetchInterval: 5_000 })
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true }, { refetchInterval: 10_000 })
  const system = trpc.system.info.useQuery(undefined, { refetchInterval: 60_000 })
  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const tiles: [string, string][] = [
    ['Tank', s.water_level_pct ? `${s.water_level_pct.value}%` : '—'],
    ['Air', s.air_temp ? `${s.air_temp.value}°` : '—'],
    ['Humidity', s.humidity ? `${s.humidity.value}%` : '—'],
    ['Light', light.data?.on ? `${light.data.level}%` : 'off'],
    ['Pump', pump.data?.on ? `${pump.data.remainingS ?? ''}s` : pump.data?.fault ? 'FAULT' : 'idle'],
    ...(system.data?.system?.caps.sensors ?? [])
      .filter(id => SENSOR_META[id].group === 'water-quality')
      .map((id): [string, string] => [SENSOR_META[id].label, formatReading(s[id])]),
  ]
  return (
    <div className="min-h-dvh bg-app p-8 text-fg">
      <div className="grid grid-cols-2 gap-6 min-[900px]:grid-cols-5">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
            <div className="text-[14px] uppercase tracking-wide text-fg-3">{label}</div>
            <div className="mt-2 font-mono text-[56px] leading-none">{value}</div>
          </div>
        ))}
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
