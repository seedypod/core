// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chart3D, ChartNote, LoadingLine, Pending, staleSince, vizStatus } from '../Chart3D'
import type { TankData } from '../shape'

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  fail: false,
}))

vi.mock('../scenes', () => {
  const make = (name: string) => (el: HTMLElement) => {
    if (fake.fail) throw new Error('Error creating WebGL context.')
    fake.calls.push(`${name}:create`)
    const canvas = document.createElement('canvas')
    el.appendChild(canvas)
    return {
      setState: (s: string) => fake.calls.push(`state:${s}`),
      setData: (d: { marks?: { now: string } }) => fake.calls.push(`data:${d.marks?.now ?? ''}`),
      dispose: () => {
        fake.calls.push('dispose')
        canvas.remove()
      },
    }
  }
  return { createTodayViz: make('today'), createTankViz: make('tank'), createLightViz: make('light'), createPodsViz: make('pods'), createSensorsViz: make('sensors') }
})

const tank = (label: string): TankData => ({ levels: [0.5, 0.4], topUps: [], cutoff: null, current: 0.4, ticks: [], marks: { full: 'full', now: label, cutoff: null, empty: 'empty' }, low: false, pumping: false, runFrom: null, runs: [], upcoming: [] })
const flush = () => act(async () => {
  await new Promise(r => setTimeout(r, 0))
})

beforeEach(() => {
  fake.calls = []
  fake.fail = false
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Chart3D without WebGL', () => {
  it('shows the flat chart and says so', () => {
    const onUnavailable = vi.fn()
    render(<Chart3D kind="tank" data={null} status="loading" label="Tank" fallback={<p>flat chart</p>} onUnavailable={onUnavailable} />)
    expect(screen.getByText('flat chart')).toBeTruthy()
    expect(screen.queryByTestId('viz-tank')).toBeNull()
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })
})

describe('Chart3D with WebGL', () => {
  beforeEach(() => {
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
  })

  it('makes the chart on mount in a box of its aspect, loads, then hands over data once per change', async () => {
    const { rerender, unmount } = render(<Chart3D kind="tank" data={null} status="loading" label="Tank level" fallback={<p>flat</p>} />)
    const box = screen.getByRole('img', { name: 'Tank level' })
    expect(box.style.aspectRatio).toBe('2.4 / 1')
    expect(box.getAttribute('aria-busy')).toBe('true')
    await flush()
    expect(fake.calls).toEqual(['tank:create', 'state:loading'])
    rerender(<Chart3D kind="tank" data={tank('40%')} status="ready" label="Tank level" fallback={<p>flat</p>} />)
    // A fresh object with the same contents is not new data.
    rerender(<Chart3D kind="tank" data={tank('40%')} status="ready" label="Tank level" fallback={<p>flat</p>} />)
    rerender(<Chart3D kind="tank" data={tank('41%')} status="ready" label="Tank level" fallback={<p>flat</p>} />)
    rerender(<Chart3D kind="tank" data={null} status="loading" label="Tank level" fallback={<p>flat</p>} />)
    rerender(<Chart3D kind="tank" data={tank('41%')} status="ready" label="Tank level" fallback={<p>flat</p>} />)
    expect(fake.calls.slice(2)).toEqual(['data:40%', 'data:41%', 'state:loading', 'data:41%'])
    unmount()
    expect(fake.calls.at(-1)).toBe('dispose')
  })

  it('says why in the middle of an empty or failed chart', async () => {
    const { rerender } = render(<Chart3D kind="light" data={null} status="empty" label="Light" message="No curve runs today." fallback={null} />)
    await flush()
    expect(screen.getByText('No curve runs today.')).toBeTruthy()
    expect(fake.calls).toContain('state:empty')
    rerender(<Chart3D kind="light" data={null} status="error" label="Light" message="Couldn't load." fallback={null} />)
    expect(screen.getByText('Couldn\'t load.')).toBeTruthy()
    expect(fake.calls.at(-1)).toBe('state:error')
    rerender(<Chart3D kind="light" data={null} status="loading" label="Light" message="Couldn't load." fallback={null} />)
    expect(screen.queryByText('Couldn\'t load.')).toBeNull()
  })

  it('falls back to the flat chart when the context can\'t be made', async () => {
    fake.fail = true
    const onUnavailable = vi.fn()
    render(<Chart3D kind="pods" data={null} status="loading" label="Pods" fallback={<p>bars</p>} onUnavailable={onUnavailable} />)
    await flush()
    expect(screen.getByText('bars')).toBeTruthy()
    expect(onUnavailable).toHaveBeenCalled()
  })

  it('falls back when the context is lost, and frees the chart', async () => {
    render(<Chart3D kind="sensors" data={null} status="loading" label="Sensors" fallback={<p>sparklines</p>} />)
    await flush()
    const canvas = screen.getByRole('img', { name: 'Sensors' }).querySelector('canvas') as HTMLCanvasElement
    act(() => {
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    })
    expect(screen.getByText('sparklines')).toBeTruthy()
    expect(fake.calls).toContain('dispose')
  })

  it('frees nothing it never made when unmounted before three.js arrives', async () => {
    const { unmount } = render(<Chart3D kind="today" data={null} status="loading" label="Today" fallback={null} />)
    unmount()
    await flush()
    expect(fake.calls).toEqual([])
  })
})

describe('status helpers', () => {
  it('loads until every request answers, errs only with nothing to show, else empty or ready', () => {
    expect(vizStatus([{ data: [1] }, { data: undefined }], false)).toBe('loading')
    expect(vizStatus([{ data: undefined, error: new Error('x') }], false)).toBe('error')
    expect(vizStatus([{ data: [], error: new Error('x') }], true)).toBe('empty')
    expect(vizStatus([{ data: [1] }], false)).toBe('ready')
  })

  it('marks data stale from the oldest fetch whose refresh failed', () => {
    expect(staleSince([{ data: [1], dataUpdatedAt: 5 }])).toBeNull()
    expect(staleSince([{ data: [1], error: new Error('x'), dataUpdatedAt: 9 }, { data: [1], error: new Error('y'), dataUpdatedAt: 7 }, { data: undefined, error: new Error('z') }])).toBe(7)
  })
})

describe('header parts', () => {
  it('holds a value\'s place with a pulsing block while loading', () => {
    const { rerender } = render(<span data-testid="v"><Pending loading sample="100%">45%</Pending></span>)
    const block = screen.getByTestId('v').firstElementChild as HTMLElement
    expect(block.textContent).toBe('100%')
    expect(block.className).toContain('animate-pulse')
    expect(block.className).toContain('text-transparent')
    rerender(<span data-testid="v"><Pending loading={false} sample="100%">45%</Pending></span>)
    expect(screen.getByTestId('v').textContent).toBe('45%')
  })

  it('shows a pulsing bar while loading, with no words on screen but Loading for a screen reader', () => {
    vi.useFakeTimers()
    render(<LoadingLine className="x" />)
    const line = screen.getByRole('status')
    expect(line.className).toContain('x')
    expect(line.className).toMatch(/animate-pulse.*motion-reduce:animate-none/)
    expect(line.getAttribute('aria-live')).toBe('polite')
    // The region mounts empty, then says Loading, so the change is announced.
    expect(line.textContent).toBe('')
    act(() => {
      vi.runAllTimers()
    })
    vi.useRealTimers()
    // The only text is the screen reader's.
    expect(screen.getByText('Loading').className).toBe('sr-only')
    expect(line.textContent).toBe('Loading')
  })

  it('offers Retry on an error, a timestamp when stale, and nothing otherwise', () => {
    const retry = vi.fn()
    const { rerender, container } = render(<ChartNote status="error" stale={null} onRetry={retry} />)
    expect(screen.getByRole('alert').textContent).toContain('Couldn\'t load')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalled()
    rerender(<ChartNote status="ready" stale={new Date(2026, 10, 10, 9, 5).getTime()} />)
    expect(screen.getByTestId('chart-stale').textContent).toMatch(/^as of 0?9:05/)
    rerender(<ChartNote status="ready" stale={null} />)
    expect(container.textContent).toBe('')
  })
})
