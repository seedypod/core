import { Cpu, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, TextField } from '@/src/components/ds/forms'
import type { DeviceEntry, DeviceKindInfo, Reading, SensorId } from '@/src/hardware/contract'
import { SensorAge } from '@/src/components/ds/charts'
import { Chart3D, ChartNote, LoadingLine, staleSince, vizStatus } from '@/src/components/charts/viz3d/Chart3D'
import { sensorsData } from '@/src/components/charts/viz3d/shape'
import { hasWebGL } from '@/src/components/Grow/TowerView'
import { formatReading, hexAddr, SENSOR_META, type SensorMeta } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'
import { CalibrationWizard } from './CalibrationWizard'

type Hours = '6' | '24' | '168'
const RANGES: Array<{ value: Hours, label: string }> = [{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }]
const GROUPS: Array<{ group: SensorMeta['group'], label: string }> = [
  { group: 'environment', label: 'Environment' },
  { group: 'water', label: 'Water' },
  { group: 'water-quality', label: 'Water quality' },
  { group: 'power', label: 'Pump' },
]
/** Tile titles where the short label used elsewhere would be ambiguous on its own. */
const TITLE: Partial<Record<SensorId, string>> = {
  air_temp: 'Air temperature',
  pcb_temp: 'Board temperature',
  water_distance: 'Distance to water',
  water_temp: 'Water temperature',
}
const titleOf = (id: SensorId) => TITLE[id] ?? SENSOR_META[id].label
/** The part name from a device kind: `dyp_a01` → `DYP-A01`. */
const partOf = (kind: string) => kind.toUpperCase().replace(/_/g, '-')
const ORDER = Object.keys(SENSOR_META) as SensorId[]
const round = (v: number) => Math.round(v * 10) / 10
const LABEL = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'

/** The unit's sensor hardware: what is fitted, its status, and adding/calibrating/removing probes. */
export function SensorsPage() {
  const devices = trpc.devices.list.useQuery()
  const latest = trpc.sensors.latest.useQuery()
  const [hours, setHours] = useState<Hours>('24')
  const [adding, setAdding] = useState(false)
  const [calibrating, setCalibrating] = useState<DeviceEntry | null>(null)
  const [removing, setRemoving] = useState<DeviceEntry | null>(null)
  // The ridgeline stands in for the tiles' sparklines; without WebGL they keep theirs.
  const [ridges, setRidges] = useState(hasWebGL)
  const inv = devices.data
  const sensors = inv?.sensors ?? []
  const kindOf = (d: DeviceEntry) => inv?.addable.find(k => k.kind === d.kind)
  // Every quantity a working sensor reports, in contract order, as a tile.
  const live = ORDER.filter(id => sensors.some(d => d.status === 'ready' && d.ids.includes(id)))
  const sourceOf = (id: SensorId) => sensors.find(d => d.status === 'ready' && d.ids.includes(id))
  const absent = sensors.filter(d => d.status === 'absent').length

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Sensors</h1>
          {inv && sensors.length > 0 && (
            <p className="text-[13px] text-fg-2">
              {`${sensors.length} device${sensors.length === 1 ? '' : 's'} · ${live.length} reading${live.length === 1 ? '' : 's'} · ${absent ? `${absent} not found` : 'all ready'}`}
            </p>
          )}
        </div>
        {live.length > 0 && <SegmentedControl ariaLabel="History range" size="sm" className="font-mono" value={hours} options={RANGES} onChange={setHours} />}
        {inv && inv.addable.length > 0 && <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add sensor</Button>}
      </div>

      {live.length > 0 && ridges && <SensorRidges ids={live} latest={latest.data ?? {}} hours={Number(hours)} onUnavailable={() => setRidges(false)} />}

      {GROUPS.map(({ group, label }) => {
        const ids = live.filter(id => SENSOR_META[id].group === group)
        if (!ids.length) return null
        return (
          <section key={group} className="flex flex-col gap-2.5">
            <h2 className={LABEL}>{label}</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
              {ids.map(id => <SensorTile key={id} sensor={id} part={partOf(sourceOf(id)?.kind ?? '')} latest={latest.data?.[id]} hours={Number(hours)} spark={!ridges} />)}
            </div>
          </section>
        )
      })}

      <section className="flex flex-col gap-2.5">
        <h2 className={LABEL}>Devices</h2>
        {inv && sensors.length === 0
          ? <div className="rounded-[14px] border border-dashed border-line-2 px-5 py-4 text-[13px] text-fg-2">The hardware daemon hasn&apos;t reported its sensors yet.</div>
          : (
              <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
                {sensors.map(d => (
                  <DeviceRow
                    key={`${d.kind}-${d.addr ?? 'gpio'}`}
                    device={d}
                    latest={latest.data ?? {}}
                    onCalibrate={kindOf(d)?.calibration.length ? () => setCalibrating(d) : undefined}
                    onRemove={() => setRemoving(d)}
                  />
                ))}
              </div>
            )}
        <p className="text-xs leading-normal text-fg-3 text-pretty">Built-in sensors come from the unit&apos;s hal.toml. Probes you add go live straight away and survive restarts. Wire the probe first: it has to answer on the I²C bus.</p>
      </section>

      {adding && inv && <AddSensorModal kinds={inv.addable} onClose={() => setAdding(false)} />}
      {calibrating && kindOf(calibrating) && <CalibrationWizard device={calibrating} kind={kindOf(calibrating) as DeviceKindInfo} onClose={() => setCalibrating(null)} />}
      {removing && <RemoveModal device={removing} onClose={() => setRemoving(null)} />}
    </div>
  )
}

/** Polyline points for a 200×50 box, top and bottom padded so a flat line stays visible. */
export function sparkPoints(values: number[]): string {
  if (values.length < 2) return ''
  const lo = Math.min(...values)
  const span = Math.max(...values) - lo || 1
  return values.map((v, i) => `${round((i / (values.length - 1)) * 200)},${round(46 - ((v - lo) / span) * 42)}`).join(' ')
}

/** Ticks under the ridgeline: the window's start, its middle and now. */
export function ridgeTicks(hours: number): Array<{ at: number, label: string }> {
  const ago = (h: number) => (hours <= 24 ? `−${h}h` : `−${Math.round((h / 24) * 10) / 10}d`)
  return [{ at: 0, label: ago(hours) }, { at: 0.5, label: ago(hours / 2) }, { at: 1, label: 'now' }]
}

/** Every live reading's history as one ridgeline, each in its own range, with the reading now at the right end. */
function SensorRidges({ ids, latest, hours, onUnavailable }: { ids: SensorId[], latest: Partial<Record<SensorId, Reading>>, hours: number, onUnavailable: () => void }) {
  // The same requests as the tiles, so they share one fetch each.
  const histories = trpc.useQueries(t => ids.map(sensor => t.telemetry.history({ sensor, hours, maxPoints: hours <= 24 ? 144 : 336 }, { refetchInterval: 60_000 })))
  const status = vizStatus(histories, histories.every(q => (q.data ?? []).length === 0))
  // The window ends when the histories were fetched, so it moves on with each refresh.
  const to = Math.max(0, ...histories.map(q => q.dataUpdatedAt))
  const scene = status === 'ready'
    ? sensorsData(ids.map((id, i) => {
        const now = latest[id]
        // The reading now closes each ridge at its right end, where its value is written.
        return { key: id, label: titleOf(id), group: SENSOR_META[id].group, current: formatReading(now), samples: [...(histories[i]?.data ?? []), ...(now ? [{ ts: now.ts, value: now.value }] : [])] }
      }), to - hours * 3_600_000, to, ridgeTicks(hours))
    : null
  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-4 sm:p-5" aria-label="Readings">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[15px] font-medium">Readings</h2>
        <span className="min-w-[180px] flex-1 text-[12px] text-fg-3">
          {status === 'loading' ? <LoadingLine /> : `${ids.length} sensor${ids.length === 1 ? '' : 's'} · each in its own range`}
        </span>
        <ChartNote status={status} stale={staleSince(histories)} onRetry={() => histories.forEach(q => void q.refetch())} />
      </div>
      <Chart3D
        kind="sensors"
        data={scene}
        status={status}
        label={`Sensor history: ${ids.map(titleOf).join(', ')}`}
        message={status === 'error' ? 'Couldn\'t load the sensor history.' : 'Nothing recorded in this window.'}
        fallback={null}
        onUnavailable={onUnavailable}
      />
    </section>
  )
}

function SensorTile({ sensor, part, latest, hours, spark = true }: { sensor: SensorId, part: string, latest?: Reading, hours: number, spark?: boolean }) {
  const q = trpc.telemetry.history.useQuery({ sensor, hours, maxPoints: hours <= 24 ? 144 : 336 }, { refetchInterval: 60_000 })
  const title = titleOf(sensor)
  const values = (q.data ?? []).map(p => p.value)
  const stats = values.length ? { min: Math.min(...values), avg: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) } : null
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-4">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{title}</span>
        <span className="font-mono text-[10px] text-fg-3">{part}</span>
      </div>
      <span className="font-mono text-[26px] font-medium leading-tight" data-testid={`trend-${sensor}-value`}>{formatReading(latest)}</span>
      {!spark
        ? null
        : q.error
          ? <InlineError>{`Couldn't load the history: ${q.error.message}`}</InlineError>
          : values.length > 1
            ? (
                <svg role="img" aria-label={title} viewBox="0 0 200 50" preserveAspectRatio="none" className="block h-[50px] w-full">
                  <polyline points={sparkPoints(values)} fill="none" stroke="var(--meter)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                </svg>
              )
            : <div className="flex h-[50px] items-center text-xs text-fg-3">{q.isLoading ? 'Loading…' : 'Nothing recorded in this window.'}</div>}
      {stats && (
        <div className="flex justify-between font-mono text-[11px] text-fg-3" data-testid={`trend-${sensor}-stats`}>
          <span>{`min ${round(stats.min)}`}</span>
          <span>{`avg ${round(stats.avg)}`}</span>
          <span>{`max ${round(stats.max)}`}</span>
        </div>
      )}
    </div>
  )
}

function DeviceRow({ device: d, latest, onCalibrate, onRemove }: {
  device: DeviceEntry
  latest: Partial<Record<SensorId, Reading>>
  onCalibrate?: () => void
  onRemove: () => void
}) {
  const ready = d.status === 'ready'
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-grid px-5 py-3.5 last:border-b-0">
      <Cpu size={16} className="shrink-0 text-fg-3" />
      <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
        <span className="text-sm">{d.label}</span>
        <span className="font-mono text-[11px] text-fg-3">{`${d.kind}${d.addr !== null ? ` · I²C ${hexAddr(d.addr)}` : ''}`}</span>
        {!ready && d.detail && <span className="text-xs text-fg-2">{d.detail}</span>}
      </div>
      {d.ids.length > 0 && (
        <span className="flex min-w-[200px] items-baseline gap-2 font-mono text-xs text-fg-2">
          {[...d.ids].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map(id => formatReading(latest[id])).join(' · ')}
          <SensorAge timestamp={latest[d.ids[0] as SensorId]?.ts} />
        </span>
      )}
      {d.source === 'user' && (
        <span className="flex gap-2">
          {onCalibrate && <Button size="sm" onClick={onCalibrate}>Calibrate</Button>}
          <Button size="sm" variant="danger" icon={Trash2} onClick={onRemove}>Remove</Button>
        </span>
      )}
      <span className="rounded-[4px] border border-line px-1.5 py-px font-mono text-[10px] text-fg-3">{d.source === 'user' ? 'added' : 'built-in'}</span>
      <span className={cn('flex items-center gap-1.5 text-xs', ready ? 'text-pod-ok' : 'text-pod-attention')}>
        <span className={cn('size-1.5 rounded-full', ready ? 'bg-pod-ok' : 'bg-pod-attention')} />
        {ready ? 'ready' : 'not found'}
      </span>
    </div>
  )
}

function AddSensorModal({ kinds, onClose }: { kinds: DeviceKindInfo[], onClose: () => void }) {
  const utils = trpc.useUtils()
  const [kind, setKind] = useState<DeviceKindInfo | undefined>(kinds[0])
  const [addr, setAddr] = useState(() => hexAddr(kinds[0]?.defaultAddr ?? null))
  const add = trpc.devices.addSensor.useMutation({
    onSuccess: () => {
      void utils.devices.invalidate()
      void utils.system.invalidate()
      void utils.sensors.invalidate()
      onClose()
    },
  })
  const parsed = Number.parseInt(addr, addr.trim().toLowerCase().startsWith('0x') ? 16 : 10)
  const pick = (k: DeviceKindInfo) => {
    setKind(k)
    setAddr(hexAddr(k.defaultAddr))
    add.reset()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Add sensor"
      icon={Plus}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!kind || !Number.isFinite(parsed) || add.isPending} onClick={() => kind && add.mutate({ kind: kind.kind, addr: parsed })}>
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      )}
    >
      <div role="radiogroup" aria-label="Sensor type" className="flex flex-col gap-2">
        {kinds.map(k => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind?.kind === k.kind}
            onClick={() => pick(k)}
            className={`flex cursor-pointer flex-col items-start gap-1 rounded-ctl border px-3 py-2.5 text-left ${kind?.kind === k.kind ? 'border-fg bg-active' : 'border-line-2 bg-transparent hover:bg-active'}`}
          >
            <span className="text-sm font-medium text-fg">{k.label}</span>
            <span className="text-xs text-fg-2">{k.description}</span>
          </button>
        ))}
      </div>
      <TextField label="I²C address" value={addr} onChange={setAddr} hint={kind?.defaultAddr != null ? `Factory default ${hexAddr(kind.defaultAddr)}. Change it only if you re-addressed the circuit.` : undefined} />
      {add.error && <InlineError>{add.error.message}</InlineError>}
    </Modal>
  )
}

function RemoveModal({ device, onClose }: { device: DeviceEntry, onClose: () => void }) {
  const utils = trpc.useUtils()
  const remove = trpc.devices.removeSensor.useMutation({
    onSuccess: () => {
      void utils.devices.invalidate()
      void utils.system.invalidate()
      void utils.sensors.invalidate()
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={`Remove ${device.label}?`}
      icon={Trash2}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={remove.isPending || device.addr === null} onClick={() => device.addr !== null && remove.mutate({ kind: device.kind, addr: device.addr })}>Remove</Button>
        </div>
      )}
    >
      <p className="text-sm text-fg-2">Its readings stop and it disappears from Home Assistant. Past history is kept. You can add it again later.</p>
      {remove.error && <InlineError>{remove.error.message}</InlineError>}
    </Modal>
  )
}
