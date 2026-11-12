// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CurveEditor } from '../CurveEditor'

const { settings } = vi.hoisted(() => ({ settings: { data: undefined as unknown } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { get: { useQuery: () => settings } } } }))
import type { LightCurve } from '../curves'

const curve: LightCurve = { id: 'day', kind: 'light', name: 'Daylight', enabled: true, days: 127, spec: { setpoints: [{ minute: 1140, level: 85 }, { minute: 360, level: 0 }] } }

afterEach(cleanup)

describe('CurveEditor', () => {
  it('lists setpoints by time and saves edits to name, days, times and levels', () => {
    const onSave = vi.fn()
    render(<CurveEditor schedule={curve} onSave={onSave} />)
    const times = screen.getAllByLabelText('Setpoint time') as HTMLInputElement[]
    expect(times.map(t => t.value)).toEqual(['06:00', '19:00'])
    expect(screen.getByText('Save').closest('button')?.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Curve name'), { target: { value: 'Long day' } })
    fireEvent.click(screen.getByLabelText('Sunday'))
    fireEvent.change(times[0] as HTMLInputElement, { target: { value: '05:30' } })
    fireEvent.change(screen.getAllByLabelText('Setpoint level')[1] as HTMLInputElement, { target: { value: '90' } })
    expect(screen.getByText('90%')).toBeTruthy()
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith({ ...curve, name: 'Long day', days: 63, spec: { setpoints: [{ minute: 1140, level: 90 }, { minute: 330, level: 0 }] } })
  })

  it('adds and removes setpoints, and Reset puts the saved curve back', () => {
    render(<CurveEditor schedule={curve} onSave={vi.fn()} />)
    fireEvent.click(screen.getByText('Setpoint'))
    expect(screen.getAllByLabelText('Setpoint time')).toHaveLength(3)
    fireEvent.click(screen.getAllByLabelText('Remove setpoint')[0] as HTMLElement)
    fireEvent.click(screen.getAllByLabelText('Remove setpoint')[0] as HTMLElement)
    expect((screen.getAllByLabelText('Setpoint time') as HTMLInputElement[]).map(t => t.value)).toEqual(['19:00'])
    fireEvent.click(screen.getByText('Reset'))
    expect(screen.getAllByLabelText('Setpoint time')).toHaveLength(2)
  })

  describe('a curve that follows the sun', () => {
    const sun = { minHours: 14, maxHours: 16, rampMin: 60, shiftMin: 0 }
    const following: LightCurve = { ...curve, spec: { setpoints: [], sun } }
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      // 10:00 PST on 12 November.
      vi.setSystemTime(new Date('2026-11-12T18:00:00Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
      settings.data = undefined
    })

    it('shows today\'s sun and the light it makes instead of setpoints, and saves its hours, ramps and shift', () => {
      settings.data = { timezone: 'America/Los_Angeles', latitude: 37.7749, longitude: -122.4194 }
      const onSave = vi.fn()
      render(<CurveEditor schedule={following} onSave={onSave} />)
      expect(screen.queryByLabelText('Setpoint time')).toBeNull()
      expect(screen.queryByText('Setpoint')).toBeNull()
      expect(screen.getByTestId('sun-today').textContent).toMatch(/^Today: sunrise 06:4\d, sunset 17:0\d, 10 h 1\d min of daylight\. The light comes up from 04:2\d and is off by 19:2\d\.$/)
      fireEvent.click(screen.getByLabelText('Increase Shift'))
      fireEvent.click(screen.getByLabelText('Increase Shift'))
      fireEvent.click(screen.getByLabelText('Increase Shift'))
      fireEvent.click(screen.getByLabelText('Increase Shift'))
      expect(screen.getByText('Centred 1 h later')).toBeTruthy()
      expect(screen.getByTestId('sun-today').textContent).toMatch(/comes up from 05:2\d and is off by 20:2\d\.$/)
      fireEvent.click(screen.getByLabelText('Decrease Most hours'))
      fireEvent.click(screen.getByLabelText('Increase Ramp'))
      fireEvent.click(screen.getByText('Save'))
      expect(onSave).toHaveBeenCalledWith({ ...following, spec: { setpoints: [], sun: { minHours: 14, maxHours: 15.5, rampMin: 75, shiftMin: 60 } } })
    })

    it('asks for the unit\'s location until it has one, and centres the day on 12:00', () => {
      settings.data = { timezone: 'UTC', latitude: null, longitude: null }
      render(<CurveEditor schedule={following} onSave={vi.fn()} />)
      expect(screen.getByTestId('sun-today').textContent).toBe('Set the unit’s location in Settings to follow sunrise and sunset; until then the day centres on 12:00. The light comes up from 04:30 and is off by 19:30.')
      fireEvent.click(screen.getByLabelText('Decrease Shift'))
      expect(screen.getByText('Centred 15 min earlier')).toBeTruthy()
    })
  })
})
