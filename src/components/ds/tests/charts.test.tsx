// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoverMark, LineChart, QualityRing, SensorAge } from '../charts'

afterEach(cleanup)

const rect = (width: number) => ({ x: 0, y: 0, left: 0, top: 0, width, height: 80, right: width, bottom: 80, toJSON: () => ({}) })

describe('LineChart hover', () => {
  it('stays a bare svg without xLabel, and reads out the point under the pointer with it', () => {
    const plain = render(<LineChart series={[{ data: [1, 2, 3], color: 'red' }]} />)
    expect(plain.container.firstElementChild?.tagName).toBe('svg')
    plain.unmount()

    const { container, getByTestId, queryByTestId } = render(
      <LineChart
        series={[{ data: [10, 20, Number.NaN, 40], color: 'red' }, { data: [1, 2, 3, 4], color: 'blue' }]}
        xLabel={i => `p${i}`}
        format={(v, s) => (s === 0 ? `${v} bpm` : v.toFixed(1))}
      />,
    )
    const box = container.firstElementChild as HTMLElement
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(rect(300))
    // A third of the way across four points lands on index 1.
    fireEvent.pointerMove(box, { clientX: 100, clientY: 10 })
    expect(getByTestId('chart-hover').textContent).toBe('p1 · 20 bpm / 2.0')
    expect(getByTestId('chart-hover').style.left).toBe(`${(1 / 3) * 100}%`)
    // A gap in one series drops just that value.
    fireEvent.pointerMove(box, { clientX: 200, clientY: 10 })
    expect(getByTestId('chart-hover').textContent).toBe('p2 · 3.0')
    fireEvent.pointerLeave(box)
    expect(queryByTestId('chart-hover')).toBeNull()
  })
})

describe('LineChart guides, markers and dots', () => {
  it('draws guides at their values, labels them, and puts markers at fractional indices', () => {
    const { container, getAllByTestId, getByText } = render(
      <LineChart
        series={[{ data: [0, 10, Number.NaN, 5, Number.NaN], color: 'red', dots: true }]}
        min={0}
        max={10}
        height={88}
        guides={[{ value: 0, label: '0', strong: true }, { value: 10, label: '10' }]}
        markers={[{ at: 0.5, label: 'gen 2' }, { at: 3.5, label: 'gen 3' }]}
      />,
    )
    const lines = [...container.querySelectorAll('line')]
    // y = 4 + (1 − v / 10) × 80: zero at the bottom, 10 at the top.
    expect(lines.slice(0, 2).map(l => [l.getAttribute('y1'), l.getAttribute('stroke')])).toEqual([['84', 'var(--text-3)'], ['4', 'var(--border-1)']])
    expect(lines.slice(2).map(l => l.getAttribute('x1'))).toEqual(['37.5', '262.5'])
    expect(getByText('10').style.top).toBe('4px')
    const markers = getAllByTestId('chart-marker')
    expect(markers.map(m => [m.textContent, m.style.left || `right ${m.style.right}`])).toEqual([['gen 2', '12.5%'], ['gen 3', 'right 12.5%']])
    // The point between two gaps has no line through it but still gets a dot.
    expect(container.querySelector('path:not([data-testid])')?.getAttribute('d')).toBe('M0.0,84.0 L75.0,4.0 M225.0,44.0')
    expect(getAllByTestId('chart-dots')[0].getAttribute('d')).toBe('M0.0,84.0 h0 M75.0,4.0 h0 M225.0,44.0 h0')
  })
})

describe('HoverMark', () => {
  it('flips the label to the left past the middle', () => {
    const { getByTestId, rerender } = render(<HoverMark pct={20} label="a" />)
    expect(getByTestId('chart-hover').querySelector('span')?.className).toContain('left-1')
    rerender(<HoverMark pct={80} label="a" />)
    expect(getByTestId('chart-hover').querySelector('span')?.className).toContain('right-1')
  })
})

describe('QualityRing', () => {
  it('fills to the score and shows its text and label', () => {
    const { container, getByText } = render(<QualityRing score={25} text="25%" label="LED life" />)
    const arc = container.querySelectorAll('circle')[1] as SVGCircleElement
    expect(arc.getAttribute('stroke-dasharray')?.split(' ')[0]).toBe((2 * Math.PI * 42 * 0.25).toFixed(1))
    expect(getByText('25%')).toBeTruthy()
    expect(getByText('LED life')).toBeTruthy()
  })
})

describe('SensorAge', () => {
  it('says how old a reading is, from an ISO time or epoch seconds, and nothing without one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'))
    const { getByText, rerender, container } = render(<SensorAge timestamp="2026-10-31T11:59:48Z" />)
    expect(getByText('12s ago')).toBeTruthy()
    rerender(<SensorAge timestamp={Date.parse('2026-10-31T11:57:00Z') / 1000} />)
    expect(getByText('3m ago')).toBeTruthy()
    rerender(<SensorAge timestamp="2026-10-31T09:00:00Z" />)
    expect(getByText('3h ago')).toBeTruthy()
    rerender(<SensorAge />)
    expect(container.textContent).toBe('')
    vi.useRealTimers()
  })
})
