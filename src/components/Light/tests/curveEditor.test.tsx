// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CurveEditor } from '../CurveEditor'
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
})
