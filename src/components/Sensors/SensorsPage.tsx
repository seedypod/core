import { Cpu, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, CardHeader, InlineError, SectionLabel, StatusDot } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { TextField } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import type { DeviceEntry, DeviceKindInfo, SensorId } from '@/src/hardware/contract'
import { TrendCard } from '@/src/components/charts/TrendCard'
import { SensorAge } from '@/src/components/ds/charts'
import { formatReading, hexAddr, SENSOR_META } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'
import { CalibrationWizard } from './CalibrationWizard'

/** The unit's sensor hardware: what is fitted, its status, and adding/calibrating/removing probes. */
export function SensorsPage() {
  const devices = trpc.devices.list.useQuery()
  const latest = trpc.sensors.latest.useQuery()
  const [adding, setAdding] = useState(false)
  const [calibrating, setCalibrating] = useState<DeviceEntry | null>(null)
  const [removing, setRemoving] = useState<DeviceEntry | null>(null)
  const inv = devices.data
  const kindOf = (d: DeviceEntry) => inv?.addable.find(k => k.kind === d.kind)
  // Every quantity a working sensor reports, in contract order, as a trend card.
  const order = Object.keys(SENSOR_META) as SensorId[]
  const live = order.filter(id => (inv?.sensors ?? []).some(d => d.status === 'ready' && d.ids.includes(id)))

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Sensors" right={inv && inv.addable.length > 0 && <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add sensor</Button>} />
      {live.length > 0 && (
        <>
          <SectionLabel>Readings</SectionLabel>
          <div className="grid gap-3 min-[640px]:grid-cols-2 min-[960px]:grid-cols-3">
            {live.map(id => <TrendCard key={id} sensor={id} title={SENSOR_META[id].label} color={SENSOR_META[id].color} icon={SENSOR_META[id].icon} latest={latest.data?.[id]} height={72} />)}
          </div>
          <SectionLabel>Hardware</SectionLabel>
        </>
      )}
      {inv && inv.sensors.length === 0 && <Card dashed><p className="text-[13px] text-fg-2">The hardware daemon hasn&apos;t reported its sensors yet.</p></Card>}
      {(inv?.sensors ?? []).map(d => (
        <Card key={`${d.kind}-${d.addr ?? 'gpio'}`} tone={d.status === 'absent' ? 'warn' : undefined}>
          <CardHeader
            title={d.label}
            subtitle={`${d.kind}${d.addr !== null ? ` · I²C ${hexAddr(d.addr)}` : ''}`}
            icon={Cpu}
            right={(
              <div className="flex items-center gap-2">
                <Badge variant={d.source === 'user' ? 'active' : 'dev'}>{d.source === 'user' ? 'Added' : 'Built-in'}</Badge>
                <StatusDot tone={d.status === 'ready' ? 'ok' : 'warn'} label={d.status === 'ready' ? 'ready' : 'not found'} />
              </div>
            )}
          />
          {d.status === 'absent' && d.detail && <p className="mt-2 text-xs text-fg-2">{d.detail}</p>}
          {d.ids.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {d.ids.map(id => (
                <span key={id} className="flex items-baseline gap-1.5 text-fg-2">
                  {SENSOR_META[id].label}
                  <span className="font-mono text-fg">{formatReading(latest.data?.[id])}</span>
                  <SensorAge timestamp={latest.data?.[id]?.ts} />
                </span>
              ))}
            </div>
          )}
          {d.source === 'user' && (
            <div className="mt-3 flex gap-2">
              {kindOf(d)?.calibration.length ? <Button size="sm" onClick={() => setCalibrating(d)}>Calibrate</Button> : null}
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => setRemoving(d)}>Remove</Button>
            </div>
          )}
        </Card>
      ))}
      <SectionLabel>About</SectionLabel>
      <p className="text-[13px] text-fg-2">Built-in sensors come from the unit&apos;s hal.toml. Probes you add here go live straight away and survive restarts; wire the probe first — it has to answer on the I²C bus to be added.</p>

      {adding && inv && <AddSensorModal kinds={inv.addable} onClose={() => setAdding(false)} />}
      {calibrating && kindOf(calibrating) && <CalibrationWizard device={calibrating} kind={kindOf(calibrating) as DeviceKindInfo} onClose={() => setCalibrating(null)} />}
      {removing && <RemoveModal device={removing} onClose={() => setRemoving(null)} />}
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
