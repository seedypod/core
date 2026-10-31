import { Check, FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { Button, InlineError, Metric } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { TextField } from '@/src/components/ds/forms'
import type { CalibrationStep, DeviceEntry, DeviceKindInfo } from '@/src/hardware/contract'
import { formatReading, SENSOR_META } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'

/**
 * Walks the probe's calibration procedure as hald describes it (`DeviceKindInfo.calibration`),
 * so any future kind gets a wizard without UI changes.
 */
export function CalibrationWizard({ device, kind, onClose }: { device: DeviceEntry, kind: DeviceKindInfo, onClose: () => void }) {
  const id = device.ids[0]
  const steps = kind.calibration
  const [i, setI] = useState(0)
  const [value, setValue] = useState(() => valueText(steps[0]))
  const [stored, setStored] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const reading = trpc.sensors.latest.useQuery(undefined, { refetchInterval: 2000 })
  const calibrate = trpc.sensors.calibrate.useMutation()
  const step = steps[i]

  const next = () => {
    if (i + 1 >= steps.length) return setDone(true)
    setI(i + 1)
    setValue(valueText(steps[i + 1]))
    calibrate.reset()
  }
  const store = () => {
    if (!step || !id) return
    const v = step.defaultValue === null ? undefined : Number(value)
    calibrate.mutate({ id, point: step.point, value: v }, {
      onSuccess: (r) => {
        setStored(r.points)
        next()
      },
    })
  }
  const clear = () => id && calibrate.mutate({ id, point: 'clear' }, { onSuccess: r => setStored(r.points) })

  return (
    <Modal
      open
      onClose={onClose}
      title={`Calibrate ${device.label}`}
      icon={FlaskConical}
      footer={done
        ? <Button variant="primary" onClick={onClose}>Done</Button>
        : (
            <div className="flex flex-wrap justify-end gap-2">
              {step?.optional && <Button variant="ghost" onClick={next}>Skip</Button>}
              <Button variant="primary" icon={Check} disabled={calibrate.isPending || (step?.defaultValue !== null && !Number.isFinite(Number(value)))} onClick={store}>
                {calibrate.isPending ? 'Storing…' : 'Store point'}
              </Button>
            </div>
          )}
    >
      {done
        ? <p className="text-sm text-fg-2">{`Calibration stored${stored !== null ? ` — the probe holds ${stored} point${stored === 1 ? '' : 's'}` : ''}.`}</p>
        : step && (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-fg-3">{`Step ${i + 1} of ${steps.length}${step.optional ? ' · optional' : ''}`}</div>
            <div className="text-[15px] font-medium">{step.label}</div>
            <p className="text-sm text-fg-2">{step.instruction}</p>
            {id && <Metric label={`Live ${SENSOR_META[id].label}`} value={formatReading(reading.data?.[id])} icon={SENSOR_META[id].icon} />}
            {step.defaultValue !== null && (
              <TextField label="Reference value" value={value} onChange={setValue} inputMode="decimal" hint="Use the value printed on your solution if it differs." />
            )}
            {stored !== null && <div className="text-xs text-fg-2">{`Points stored so far: ${stored}`}</div>}
            {calibrate.error && <InlineError>{calibrate.error.message}</InlineError>}
            <details className="text-xs text-fg-3">
              <summary className="cursor-pointer">Advanced</summary>
              <Button variant="danger" size="sm" className="mt-2" onClick={clear}>Clear stored calibration</Button>
            </details>
          </div>
        )}
    </Modal>
  )
}

function valueText(step: CalibrationStep | undefined): string {
  return step?.defaultValue === null || step?.defaultValue === undefined ? '' : String(step.defaultValue)
}
