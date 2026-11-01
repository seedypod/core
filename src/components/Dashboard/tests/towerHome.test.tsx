// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TowerHome } from '../TowerHome'

const { data, calls, tower } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { setLight: vi.fn(), runOnce: vi.fn(), stop: vi.fn() },
  tower: { props: null as null | Record<string, unknown> },
}))

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, search }: { children: ReactNode, to: string, search?: { pod: number } }) => <a href={search ? `${to}?pod=${search.pod}` : to}>{children}</a> }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name), refetch: vi.fn() }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: () => ({ isPending: false, error: data.get(`${name}Error`) ?? null, mutate: (i?: unknown, o?: { onSettled?: () => void }) => {
    calls[name](i)
    o?.onSettled?.()
  } }) })
  return {
    trpc: {
      sensors: { latest: query('sensors') },
      light: { get: query('light'), set: mutation('setLight'), owner: query('owner') },
      telemetry: { history: { useQuery: (i: { sensor: string }) => ({ data: data.get(`history:${i.sensor}`) }) } },
      pump: { get: query('pump'), runOnce: mutation('runOnce'), stop: mutation('stop') },
      alerts: { list: query('alerts') },
      system: { info: query('system') },
      grow: { current: query('grow'), pods: query('pods') },
      vision: { podTrends: query('trends') },
    },
  }
})

// The real view needs WebGL; this one renders the chips it's given and exposes its callbacks.
vi.mock('@/src/components/Grow/TowerView', () => ({
  TowerView: (props: { controls: ReactNode }) => {
    tower.props = props
    return <div data-testid="tower">{props.controls}</div>
  },
}))

const r = (value: number, unit: string) => ({ value, unit, ts: '2026-10-31T00:00:00Z' })
beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  data.set('sensors', { air_temp: r(22.5, '°C'), humidity: r(51, '%'), pcb_temp: r(31, '°C'), water_level_pct: r(64, '%'), water_distance: r(9, 'cm'), pump_w: r(0, 'W') })
  data.set('light', { on: true, level: 85, since: '' })
  data.set('pump', { on: false, level: 0, remainingS: null, fault: null })
  data.set('alerts', [])
  data.set('system', { system: { caps: { sensors: ['air_temp', 'ph'] } } })
  data.set('grow', { cycle: { stage: 'vegetative', notes: 'greens' }, day: 19 })
  data.set('pods', [{ slot: 1, plant: 'Basil', status: 'growing', notes: 'pinch tops', plantedAt: null, updatedAt: '' }, { slot: 2, plant: null, status: 'empty', notes: '', plantedAt: null, updatedAt: '' }])
  data.set('trends', [{ slot: 1, green: 0.42, verdict: 'growing', slope: 0, samples: 6 }])
  data.set('owner', { source: 'schedule', level: 85, leaseId: null, manualUntil: null, schedule: 85 })
  const hist = (vals: number[]) => vals.map((value, i) => ({ ts: new Date(Date.UTC(2026, 9, 31, i)).toISOString(), value }))
  data.set('history:water_level_pct', hist([80, 72, 64]))
  data.set('history:air_temp', hist([21, 23.5, 22.5]))
  data.set('history:humidity', hist([48, 55, 51]))
})
afterEach(cleanup)

const chip = (label: string) => within(screen.getByTestId('tower')).getByRole('button', { name: label })

describe('Home', () => {
  it('puts the light, tank and air readings in a row on the tower, and names the parts on hover', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect(chip('85%')).toBeTruthy()
    expect(chip('64%')).toBeTruthy()
    expect(chip('22.5°C · 51%')).toBeTruthy()
    expect(tower.props?.partLabels).toEqual({ light: 'Grow light · 85%', tank: 'Tank · 64%' })
    expect(tower.props).toMatchObject({ waterPct: 64, lightLevel: 85, selected: null })
    expect(screen.getByTestId('home-counts').textContent).toBe('1 growing · 0 ready · 0 attention')
    expect(screen.getByText('Water quality')).toBeTruthy()
  })

  it('opens the light control in place: on/off, and brightness on release', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    fireEvent.click(chip('85%'))
    const panel = screen.getByRole('dialog', { name: '85%' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn off' }))
    expect(calls.setLight).toHaveBeenCalledWith({ on: false })
    fireEvent.change(within(panel).getByLabelText('Brightness'), { target: { value: '40' } })
    expect(within(panel).getByText('40%')).toBeTruthy()
    fireEvent.pointerUp(within(panel).getByLabelText('Brightness'))
    expect(calls.setLight).toHaveBeenLastCalledWith({ level: 40 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('runs and stops the pump from the tank, and flags a low tank', () => {
    data.set('alerts', [{ id: 1, kind: 'water_low', active: true, detail: 'tank low' }])
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect(chip('64%').className).toMatch(/status-warn/)
    act(() => (tower.props?.onPart as (p: string) => void)('tank'))
    fireEvent.click(screen.getByRole('button', { name: 'Run 5 min' }))
    expect(calls.runOnce).toHaveBeenCalledWith({ durationS: 300 })
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('tank low')).toBeTruthy()
  })

  it('shows the pod picked on the tower, with a link to edit it on Grow', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    act(() => (tower.props?.onSelect as (s: number) => void)(1))
    expect(screen.getByText('Pod 1')).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.getByText('pinch tops')).toBeTruthy()
    expect(screen.getByText('Edit on Grow').closest('a')?.getAttribute('href')).toBe('/grow?pod=1')
  })

  it('charts the last 24 hours of air and humidity, with min, avg and max', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    fireEvent.click(chip('22.5°C · 51%'))
    expect(screen.getByText('Environment')).toBeTruthy()
    expect(screen.getByLabelText('Air temperature, last 24 hours').textContent).toContain('min 21°Cavg 22.3°Cmax 23.5°C')
    expect(screen.getByLabelText('Humidity, last 24 hours').textContent).toContain('max 55%')
  })

  it('charts the tank in its panel and peeks at it on hover', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    const tank = chip('64%')
    fireEvent.pointerEnter(tank.parentElement as HTMLElement, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip').textContent).toContain('24h · 64%–80%')
    fireEvent.pointerLeave(tank.parentElement as HTMLElement)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(tank)
    expect(screen.getByLabelText('Tank level, last 24 hours').textContent).toContain('min 64%avg 72%max 80%')
  })

  it('closes a panel on a click outside it, and names who holds the light on hover', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    fireEvent.click(chip('85%'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(within(screen.getByRole('dialog')).getByLabelText('Brightness'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.pointerEnter(chip('85%').parentElement as HTMLElement, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip').textContent).toContain('Grow light · on schedule')
  })
})
