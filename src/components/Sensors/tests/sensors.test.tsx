// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEntry, DeviceInventory, DeviceKindInfo } from '@/src/hardware/contract'
import { formatReading, hexAddr } from '@/src/lib/sensorMeta'
import { CalibrationWizard } from '../CalibrationWizard'
import { SensorsPage, sparkPoints } from '../SensorsPage'

// The pages only need the hooks' shape; each test sets what the queries return and
// what the mutations do, so the trpc client itself stays out of the picture.
// Hoisted because vi.mock's factory runs before the rest of this module.
const { q, mutations, mutationError, invalidate, useMutation, history } = vi.hoisted(() => {
  const history = { calls: [] as unknown[], data: [{ ts: '2026-10-31T10:00:00Z', value: 21 }, { ts: '2026-10-31T11:00:00Z', value: 23 }] as Array<{ ts: string, value: number }>, error: null as Error | null }
  const q = { devices: { data: undefined as DeviceInventory | undefined }, latest: { data: undefined as Record<string, { value: number, unit: string }> | undefined } }
  const mutations = { addSensor: vi.fn(), removeSensor: vi.fn(), calibrate: vi.fn() }
  const mutationError = { current: null as Error | null }
  const invalidate = vi.fn()
  const useMutation = (name: keyof typeof mutations) => (opts?: { onSuccess?: (r: unknown) => void }) => ({
    isPending: false,
    error: mutationError.current,
    reset: vi.fn(),
    mutate: (input: unknown, local?: { onSuccess?: (r: unknown) => void }) => {
      const r = mutations[name](input)
      if (r !== undefined) {
        opts?.onSuccess?.(r)
        local?.onSuccess?.(r)
      }
    },
  })
  return { q, mutations, mutationError, invalidate, useMutation, history }
})

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ devices: { invalidate }, system: { invalidate }, sensors: { invalidate } }),
    devices: { list: { useQuery: () => q.devices }, addSensor: { useMutation: useMutation('addSensor') }, removeSensor: { useMutation: useMutation('removeSensor') } },
    sensors: { latest: { useQuery: () => q.latest }, calibrate: { useMutation: useMutation('calibrate') } },
    telemetry: { history: { useQuery: (input: unknown) => {
      history.calls.push(input)
      return { data: history.data, isLoading: false, error: history.error }
    } } },
  },
}))

const ph: DeviceKindInfo = {
  kind: 'ezo_ph',
  label: 'pH probe (Atlas EZO)',
  description: 'Atlas Scientific EZO-pH circuit, I²C.',
  ids: ['ph'],
  bus: 'i2c',
  defaultAddr: 0x63,
  calibration: [
    { point: 'mid', label: 'Mid point', instruction: 'Rinse and place in the 7.00 buffer.', defaultValue: 7, optional: false },
    { point: 'low', label: 'Low point', instruction: 'Place in the 4.00 buffer.', defaultValue: 4, optional: true },
  ],
}
const ec: DeviceKindInfo = { ...ph, kind: 'ezo_ec', label: 'EC probe (Atlas EZO)', ids: ['ec'], defaultAddr: 0x64, calibration: [{ point: 'dry', label: 'Dry', instruction: 'Dry the probe.', defaultValue: null, optional: false }] }
const builtIn: DeviceEntry = { kind: 'dht20', label: 'Air temperature + humidity (DHT20)', addr: 0x38, ids: ['air_temp', 'humidity'], source: 'config', status: 'ready', detail: '' }
const added: DeviceEntry = { kind: 'ezo_ph', label: 'pH probe (Atlas EZO)', addr: 0x63, ids: ['ph'], source: 'user', status: 'ready', detail: '' }
const absent: DeviceEntry = { ...builtIn, kind: 'ina219', label: 'Pump power monitor (INA219)', addr: 0x40, ids: ['pump_v'], status: 'absent', detail: 'no device at 0x40' }

beforeEach(() => {
  q.devices.data = { sensors: [builtIn, added, absent], addable: [ph, ec] }
  q.latest.data = { ph: { value: 6.1, unit: 'pH' }, air_temp: { value: 22.5, unit: '°C' } }
  mutationError.current = null
  for (const m of Object.values(mutations)) m.mockReset()
  invalidate.mockReset()
  history.calls = []
  history.data = [{ ts: '2026-10-31T10:00:00Z', value: 21 }, { ts: '2026-10-31T11:00:00Z', value: 23 }]
  history.error = null
})
afterEach(cleanup)

describe('sensorMeta', () => {
  it('formats readings per unit and the empty case', () => {
    expect(formatReading(undefined)).toBe('—')
    expect(formatReading({ value: 6.1, unit: 'pH' })).toBe('6.1')
    expect(formatReading({ value: 22.5, unit: '°C' })).toBe('22.5°C')
    expect(formatReading({ value: 1.4, unit: 'mS/cm' })).toBe('1.4 mS/cm')
  })
  it('prints I²C addresses as two-digit hex', () => {
    expect(hexAddr(0x63)).toBe('0x63')
    expect(hexAddr(8)).toBe('0x08')
    expect(hexAddr(null)).toBe('—')
  })
})

describe('SensorsPage', () => {
  it('lists every device with its source, status and latest reading', () => {
    render(<SensorsPage />)
    expect(screen.getByText('3 devices · 3 readings · 1 not found')).toBeTruthy()
    expect(screen.getAllByText('built-in')).toHaveLength(2)
    expect(screen.getAllByText('added')).toHaveLength(1)
    expect(screen.getByText('not found')).toBeTruthy()
    expect(screen.getByText('no device at 0x40')).toBeTruthy()
    // Each reading shows in its tile, grouped, with the part that reports it.
    expect(screen.getAllByText('6.1')).toHaveLength(2)
    expect(screen.getByText('22.5°C')).toBeTruthy()
    expect(screen.getByText('22.5°C · —')).toBeTruthy()
    expect(screen.getByText('Environment')).toBeTruthy()
    expect(screen.getByText('Water quality')).toBeTruthy()
    expect(screen.getByText('Air temperature')).toBeTruthy()
    expect(screen.getByText('EZO-PH')).toBeTruthy()
    expect(screen.getAllByText('DHT20')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'pH' })).toBeTruthy()
    expect(screen.getAllByText('min 21')).toHaveLength(3)
    // Only app-added probes can be calibrated or removed.
    expect(screen.getAllByText('Remove')).toHaveLength(1)
    expect(screen.getAllByText('Calibrate')).toHaveLength(1)
  })

  it('reloads every tile\'s history for the chosen range', () => {
    render(<SensorsPage />)
    expect(history.calls.at(-1)).toEqual({ sensor: 'ph', hours: 24, maxPoints: 144 })
    fireEvent.click(screen.getByRole('tab', { name: '7d' }))
    expect(history.calls.at(-1)).toEqual({ sensor: 'ph', hours: 168, maxPoints: 336 })
  })

  it('says when a window has no history or the history fails', () => {
    history.data = []
    render(<SensorsPage />)
    expect(screen.getAllByText('Nothing recorded in this window.')).toHaveLength(3)
    cleanup()
    history.error = new Error('db locked')
    render(<SensorsPage />)
    expect(screen.getAllByText('Couldn\'t load the history: db locked')).toHaveLength(3)
  })

  it('reports all ready when every device answers', () => {
    q.devices.data = { sensors: [builtIn], addable: [] }
    render(<SensorsPage />)
    expect(screen.getByText('1 device · 2 readings · all ready')).toBeTruthy()
  })

  it('says so while the daemon has not reported', () => {
    q.devices.data = { sensors: [], addable: [] }
    render(<SensorsPage />)
    expect(screen.getByText(/hasn't reported its sensors yet/)).toBeTruthy()
    expect(screen.queryByText('Add sensor')).toBeNull()
  })

  it('adds a probe with the kind\'s default address and refreshes', () => {
    mutations.addSensor.mockReturnValue({ ok: true, detail: '' })
    render(<SensorsPage />)
    fireEvent.click(screen.getByText('Add sensor'))
    const dialog = screen.getByRole('dialog')
    expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('0x63')
    fireEvent.click(screen.getByRole('radio', { name: /EC probe/ }))
    expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('0x64')
    fireEvent.change(dialog.querySelector('input') as HTMLInputElement, { target: { value: '0x65' } })
    fireEvent.click(screen.getByText('Add'))
    expect(mutations.addSensor).toHaveBeenCalledWith({ kind: 'ezo_ec', addr: 0x65 })
    expect(invalidate).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the daemon\'s refusal inline and disables Add on a bad address', () => {
    mutationError.current = new Error('0x63 is already used by pH probe (Atlas EZO)')
    render(<SensorsPage />)
    fireEvent.click(screen.getByText('Add sensor'))
    expect(screen.getByText('0x63 is already used by pH probe (Atlas EZO)')).toBeTruthy()
    const input = screen.getByRole('dialog').querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'zz' } })
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('removes an added probe after confirmation', () => {
    mutations.removeSensor.mockReturnValue({ ok: true, detail: '' })
    render(<SensorsPage />)
    fireEvent.click(screen.getByText('Remove'))
    expect(screen.getByRole('dialog', { name: 'Remove pH probe (Atlas EZO)?' })).toBeTruthy()
    fireEvent.click(screen.getAllByText('Remove').at(-1) as HTMLElement)
    expect(mutations.removeSensor).toHaveBeenCalledWith({ kind: 'ezo_ph', addr: 0x63 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the calibration wizard for an added probe', () => {
    render(<SensorsPage />)
    fireEvent.click(screen.getByText('Calibrate'))
    expect(screen.getByRole('dialog', { name: 'Calibrate pH probe (Atlas EZO)' })).toBeTruthy()
    expect(screen.getByText('Step 1 of 2')).toBeTruthy()
  })
})

describe('sparkPoints', () => {
  it('spans the box and keeps a flat line inside it', () => {
    expect(sparkPoints([1])).toBe('')
    expect(sparkPoints([0, 10])).toBe('0,46 200,4')
    expect(sparkPoints([5, 5, 5])).toBe('0,46 100,46 200,46')
  })
})

describe('CalibrationWizard', () => {
  it('walks the kind\'s steps, stores each point and reports the total', () => {
    let points = 0
    mutations.calibrate.mockImplementation(() => ({ ok: true, points: ++points }))
    const onClose = vi.fn()
    render(<CalibrationWizard device={added} kind={ph} onClose={onClose} />)
    expect(screen.getByText('Rinse and place in the 7.00 buffer.')).toBeTruthy()
    expect(screen.getByText('6.1')).toBeTruthy()
    fireEvent.change(screen.getByRole('dialog').querySelector('input') as HTMLInputElement, { target: { value: '7.02' } })
    fireEvent.click(screen.getByText('Store point'))
    expect(mutations.calibrate).toHaveBeenCalledWith({ id: 'ph', point: 'mid', value: 7.02 })
    expect(screen.getByText('Step 2 of 2 · optional')).toBeTruthy()
    expect(screen.getByText('Points stored so far: 1')).toBeTruthy()
    fireEvent.click(screen.getByText('Store point'))
    expect(screen.getByText(/the probe holds 2 points/)).toBeTruthy()
    fireEvent.click(screen.getByText('Done'))
    expect(onClose).toHaveBeenCalled()
  })

  it('lets an optional step be skipped and sends no value for value-less steps', () => {
    mutations.calibrate.mockReturnValue({ ok: true, points: 1 })
    render(<CalibrationWizard device={added} kind={ph} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Store point'))
    fireEvent.click(screen.getByText('Skip'))
    expect(screen.getByText(/the probe holds 1 point\./)).toBeTruthy()
    cleanup()

    render(<CalibrationWizard device={{ ...added, kind: 'ezo_ec', ids: ['ec'] }} kind={ec} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog').querySelector('input')).toBeNull()
    fireEvent.click(screen.getByText('Store point'))
    expect(mutations.calibrate).toHaveBeenLastCalledWith({ id: 'ec', point: 'dry', value: undefined })
  })

  it('clears stored calibration from Advanced and surfaces errors', () => {
    mutations.calibrate.mockReturnValue({ ok: true, points: 0 })
    mutationError.current = new Error('probe did not answer')
    render(<CalibrationWizard device={added} kind={ph} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear stored calibration'))
    expect(mutations.calibrate).toHaveBeenCalledWith({ id: 'ph', point: 'clear' })
    expect(screen.getByText('Points stored so far: 0')).toBeTruthy()
    expect(screen.getByText('probe did not answer')).toBeTruthy()
  })
})
