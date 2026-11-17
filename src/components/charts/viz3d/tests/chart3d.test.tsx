// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PickHooks, VizSpot } from '../base'
import { Chart3D, ChartNote, LoadingLine, Pending, staleSince, vizStatus, type ChartPick } from '../Chart3D'
import type { TankData } from '../shape'

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  fail: false,
  hooks: null as PickHooks | null,
  spots: {} as Record<number, VizSpot>,
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
      listen: (h: PickHooks | null) => {
        fake.hooks = h
      },
      spot: (id: number) => fake.spots[id] ?? null,
    }
  }
  return { createTodayViz: make('today'), createTankViz: make('tank'), createLightViz: make('light'), createPodsViz: make('pods'), createSensorsViz: make('sensors') }
})

const tank = (label: string): TankData => ({ levels: [0.5, 0.4], topUps: [], cutoff: null, current: 0.4, ticks: [], marks: { full: 'full', now: label, cutoff: null, empty: 'empty' }, low: false, warnOnly: false, pumping: false, runFrom: null, runs: [], upcoming: [] })
const flush = () => act(async () => {
  await new Promise(r => setTimeout(r, 0))
})

beforeEach(() => {
  fake.calls = []
  fake.fail = false
  fake.hooks = null
  fake.spots = {}
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

describe('Chart3D with pods to pick', () => {
  beforeEach(() => {
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
    fake.spots = { 3: { x: 30, y: 40, width: 600, height: 250 }, 5: { x: 50, y: 60, width: 600, height: 250 } }
  })
  const points = [{ id: 3, label: 'Pod 3, Basil' }, { id: 5, label: 'Pod 5, empty' }, { id: 9, label: 'Pod 9, Mint' }]
  const chart = (pick: Partial<ChartPick> = {}) => (
    <Chart3D
      kind="pods"
      data={null}
      status="loading"
      label="Leaf cover"
      fallback={null}
      pick={{ points, pinned: null, onPick: () => {}, card: (id, at) => <div data-testid="card">{`${id} at ${at.x},${at.y}`}</div>, ...pick }}
    />
  )
  const card = () => screen.queryByTestId('card')?.textContent ?? null
  const hooks = () => fake.hooks as PickHooks

  it('shows the hovered pod\'s card at its spot, then the pinned one\'s, and follows it as the chart turns', async () => {
    const onPick = vi.fn()
    const { rerender } = render(chart({ onPick }))
    await flush()
    expect(card()).toBeNull()
    act(() => hooks().hover(3))
    expect(card()).toBe('3 at 30,40')
    act(() => hooks().hover(null))
    expect(card()).toBeNull()
    act(() => hooks().pick(5))
    expect(onPick).toHaveBeenCalledWith(5)
    rerender(chart({ onPick, pinned: 5 }))
    expect(card()).toBe('5 at 50,60')
    // Hovering another shows it in place of the pinned pod, until the pointer moves off.
    act(() => hooks().hover(3))
    expect(card()).toBe('3 at 30,40')
    act(() => hooks().hover(null))
    expect(card()).toBe('5 at 50,60')
    fake.spots[5] = { x: 80, y: 60, width: 600, height: 250 }
    act(() => hooks().moved())
    expect(card()).toBe('5 at 80,60')
    // Less than a pixel isn't a move.
    fake.spots[5] = { x: 80.2, y: 60, width: 600, height: 250 }
    act(() => hooks().moved())
    expect(card()).toBe('5 at 80,60')
    // Turned out of sight, the card goes.
    delete fake.spots[5]
    act(() => hooks().moved())
    expect(card()).toBeNull()
  })

  it('offers a keyboard a button per pod: focus shows its card and a ring on it, Enter or a click picks it', async () => {
    const onPick = vi.fn()
    render(chart({ onPick, pinned: 3 }))
    await flush()
    const group = screen.getByTestId('viz-pods-points')
    expect(group.className).toBe('sr-only')
    expect(screen.getByRole('button', { name: 'Pod 3, Basil' }).getAttribute('aria-pressed')).toBe('true')
    const five = screen.getByRole('button', { name: 'Pod 5, empty' })
    expect(five.getAttribute('aria-pressed')).toBe('false')
    fireEvent.focus(five)
    expect(card()).toBe('5 at 50,60')
    const ring = screen.getByTestId('viz-focus')
    expect([ring.style.left, ring.style.top]).toEqual(['50px', '60px'])
    fireEvent.click(five)
    expect(onPick).toHaveBeenCalledWith(5)
    fireEvent.blur(five)
    expect(screen.queryByTestId('viz-focus')).toBeNull()
    // Back to the pinned pod's card once focus leaves.
    expect(card()).toBe('3 at 30,40')
    // A pod the chart can't place has no card.
    fireEvent.focus(screen.getByRole('button', { name: 'Pod 9, Mint' }))
    expect(card()).toBeNull()
  })

  it('leaves a chart without pods to pick as it was', async () => {
    render(<Chart3D kind="tank" data={null} status="loading" label="Tank" fallback={null} />)
    await flush()
    expect(fake.hooks).toBeNull()
    expect(screen.getByRole('img', { name: 'Tank' }).parentElement?.tagName).toBe('DIV')
    expect(screen.queryByTestId('viz-tank-points')).toBeNull()
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
