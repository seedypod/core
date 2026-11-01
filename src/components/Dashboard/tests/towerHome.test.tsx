// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TowerHome } from '../TowerHome'

const { data, calls, tower } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { setLight: vi.fn(), runOnce: vi.fn(), stop: vi.fn(), markHarvested: vi.fn() },
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
      grow: { current: query('grow'), pods: query('pods'), harvest: query('harvest'), markHarvested: mutation('markHarvested') },
      vision: { podTrends: query('trends') },
    },
  }
})

// The real view needs WebGL; this one renders the chips and pod action it's given and exposes its callbacks.
vi.mock('@/src/components/Grow/TowerView', () => ({
  TowerView: (props: { controls: ReactNode, status: ReactNode, podAction: ReactNode, aside: ReactNode }) => {
    tower.props = props
    return (
      <div data-testid="tower">
        {props.controls}
        {props.status}
        <div data-testid="pod-action">{props.podAction}</div>
        {props.aside}
      </div>
    )
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
  data.set('trends', [{ slot: 1, green: 0.42, verdict: 'growing', slope: 0, samples: 6, recent: [0.3, 0.42] }])
  data.set('owner', { source: 'schedule', level: 85, leaseId: null, manualUntil: null, schedule: 85 })
  const hist = (vals: number[]) => vals.map((value, i) => ({ ts: new Date(Date.UTC(2026, 9, 31, i)).toISOString(), value }))
  data.set('history:water_level_pct', hist([80, 72, 64]))
  data.set('history:air_temp', hist([21, 23.5, 22.5]))
  data.set('history:humidity', hist([48, 55, 51]))
})
afterEach(cleanup)

const chip = (label: string) => within(screen.getByTestId('tower')).getByRole('button', { name: label })

describe('Home', () => {
  it('puts the light, tank, air and water-quality readings in a row on the tower, and names the parts on hover', () => {
    data.set('sensors', { ...data.get('sensors') as object, ph: r(6.1, 'pH') })
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect(chip('85%')).toBeTruthy()
    expect(chip('64%')).toBeTruthy()
    expect(chip('22.5°C · 51%')).toBeTruthy()
    expect(tower.props?.partLabels).toEqual({ light: 'Grow light · 85%', tank: 'Tank · 64%' })
    expect(tower.props).toMatchObject({ waterPct: 64, lightLevel: 85, selected: null })
    fireEvent.click(chip('pH 6.1'))
    const panel = screen.getByRole('dialog', { name: 'pH 6.1' })
    expect(panel.textContent).toContain('Water quality')
    expect(within(panel).getByText('pH')).toBeTruthy()
  })

  it('shows the cycle\'s day on the tower, with the stage and pod counts in its panel', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    fireEvent.click(chip('Day 19'))
    const panel = screen.getByRole('dialog', { name: 'Day 19' })
    expect(panel.textContent).toContain('Day 19 · vegetative')
    expect(panel.textContent).toContain('greens')
    expect(screen.getByTestId('home-counts').textContent).toBe('1 growing · 0 ready · 0 attention')
    cleanup()
    data.set('grow', { cycle: null, day: null })
    render(<TowerHome onUnavailable={vi.fn()} />)
    fireEvent.click(chip('No cycle'))
    expect(screen.getByRole('dialog', { name: 'No cycle' }).textContent).toContain('Start one on Grow')
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

  it('turns the tank\'s icon blue and pulses it while the pump runs', () => {
    const { unmount } = render(<TowerHome onUnavailable={vi.fn()} />)
    expect(chip('64%').querySelector('svg')?.getAttribute('class')).toContain('text-fg-2')
    unmount()
    data.set('pump', { on: true, level: 80, remainingS: 200, fault: null })
    render(<TowerHome onUnavailable={vi.fn()} />)
    const icon = chip('64%').querySelector('svg') as SVGElement
    expect(icon.getAttribute('class')).toContain('motion-safe:animate-pulse')
    expect(icon.style.color).toBe('var(--accent-water)')
  })

  it('runs and stops the pump from the tank, and flags a low tank', () => {
    data.set('alerts', [{ id: 1, kind: 'water_low', active: true, detail: 'tank low' }])
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect(chip('64%').className).toMatch(/status-warn/)
    act(() => (tower.props?.onPart as (p: string) => void)('tank'))
    fireEvent.click(screen.getByRole('button', { name: 'Run 5 min' }))
    expect(calls.runOnce).toHaveBeenCalledWith({ durationS: 300 })
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(chip('1 alert'))
    expect(chip('1 alert').className).toMatch(/status-warn/)
    expect(within(screen.getByRole('dialog', { name: '1 alert' })).getByText('tank low')).toBeTruthy()
    expect(screen.getByText('All alerts').closest('a')?.getAttribute('href')).toBe('/alerts')
  })

  it('lays the cycle down the right: its day and stage, a count per status, and the pods to harvest or see to', () => {
    data.set('pods', [
      { slot: 1, plant: 'Basil', status: 'growing', notes: '', plantedAt: null, updatedAt: '' },
      { slot: 3, plant: 'Jalapeño', status: 'harvest', notes: '', plantedAt: null, updatedAt: '' },
      { slot: 9, plant: 'Kale', status: 'attention', notes: 'yellowing leaves', plantedAt: null, updatedAt: '' },
      { slot: 10, plant: null, status: 'empty', notes: '', plantedAt: null, updatedAt: '' },
    ])
    render(<TowerHome onUnavailable={vi.fn()} />)
    const panel = screen.getByRole('region', { name: 'Grow cycle' })
    expect(panel.textContent).toContain('Day 19')
    expect(panel.textContent).toContain('Vegetative · greens')
    expect(within(panel).getByTestId('cycle-counts').textContent).toBe('Growing1Soon0Ready1Attention1Seeded0Empty1')
    const kale = within(panel).getByRole('button', { name: /Kale/ })
    expect(kale.textContent).toBe('KalePod 9yellowing leaves')
    expect(within(panel).getByRole('button', { name: /Jalapeño/ }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(kale)
    expect(tower.props?.selected).toBe(9)
    expect(kale.getAttribute('aria-pressed')).toBe('true')
    // The day chip is for narrow views only.
    expect(chip('Day 19').parentElement?.parentElement?.className).toContain('@min-[900px]:hidden')
  })

  it('lists pods by the harvest outlook too, and gives the picked one its action: cut it, or see it on camera', () => {
    data.set('pods', [
      { slot: 1, plant: 'Basil', status: 'growing', notes: '', plantedAt: null, updatedAt: '', statusSince: null },
      { slot: 2, plant: 'Arugula', status: 'growing', notes: '', plantedAt: null, updatedAt: '', statusSince: null },
      { slot: 9, plant: 'Kale', status: 'attention', notes: 'yellowing', plantedAt: null, updatedAt: '', statusSince: null },
    ])
    const outlook = (slot: number, state: string, o = {}) => ({ slot, state, window: null, cover: 0.3, targetCover: 0.4, daysToReady: null, daysLeft: null, reason: '', ...o })
    data.set('harvest', [outlook(1, 'soon', { daysToReady: 4.6 }), outlook(2, 'ready', { daysLeft: 6 }), outlook(9, 'growing')])
    render(<TowerHome onUnavailable={vi.fn()} />)
    const panel = screen.getByRole('region', { name: 'Grow cycle' })
    expect(within(panel).getByText('Ready to harvest').parentElement?.textContent).toBe('Ready to harvestArugulaPod 2best within 6 d')
    expect(within(panel).getByText('Coming up').parentElement?.textContent).toBe('Coming upBasilPod 1in about 5 d')
    expect((tower.props?.pods as { harvest: unknown }[])[1]?.harvest).toMatchObject({ state: 'ready' })
    act(() => (tower.props?.onSelect as (s: number) => void)(2))
    fireEvent.click(within(screen.getByTestId('pod-action')).getByRole('button', { name: 'Mark harvested' }))
    expect(calls.markHarvested).toHaveBeenCalledWith({ slot: 2 })
    act(() => (tower.props?.onSelect as (s: number) => void)(9))
    expect(within(screen.getByTestId('pod-action')).queryByRole('button', { name: 'Mark harvested' })).toBeNull()
    expect(within(screen.getByTestId('pod-action')).getByText('View on camera').closest('a')?.getAttribute('href')).toBe('/cameras')
    act(() => (tower.props?.onSelect as (s: number) => void)(1))
    expect(screen.getByTestId('pod-action').textContent).toBe('Edit on Grow')
  })

  it('gives the tower each pod\'s trend and notes for its callout, links the picked one to Grow, and unpicks it on a second click', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    expect((tower.props?.pods as unknown[])[0]).toMatchObject({ slot: 1, plant: 'Basil', green: 0.42, verdict: 'growing', recent: [0.3, 0.42], notes: 'pinch tops' })
    expect(screen.getByTestId('pod-action').textContent).toBe('')
    act(() => (tower.props?.onSelect as (s: number) => void)(1))
    expect(tower.props?.selected).toBe(1)
    expect(screen.getByText('Edit on Grow').closest('a')?.getAttribute('href')).toBe('/grow?pod=1')
    act(() => (tower.props?.onSelect as (s: number) => void)(1))
    expect(tower.props?.selected).toBeNull()
  })

  it('charts the last 24 hours of air and humidity, with min, avg and max', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    fireEvent.click(chip('22.5°C · 51%'))
    expect(screen.getByText('Environment')).toBeTruthy()
    expect(screen.getByLabelText('Air temperature, last 24 hours').textContent).toContain('min 21°Cavg 22.3°Cmax 23.5°C')
    expect(screen.getByLabelText('Humidity, last 24 hours').textContent).toContain('max 55%')
  })

  it('opens a panel on hover, keeps it while the pointer moves into it, and closes it after leaving', () => {
    vi.useFakeTimers()
    try {
      render(<TowerHome onUnavailable={vi.fn()} />)
      const tank = chip('64%').parentElement as HTMLElement
      fireEvent.pointerEnter(tank, { pointerType: 'mouse' })
      const panel = screen.getByRole('dialog', { name: '64%' })
      expect(within(panel).getByLabelText('Tank level, last 24 hours').textContent).toContain('min 64%avg 72%max 80%')
      expect(within(panel).getByRole('button', { name: 'Run 5 min' })).toBeTruthy()
      // Straying off the edge and back in within the grace period keeps it open.
      fireEvent.pointerLeave(tank, { pointerType: 'mouse' })
      act(() => vi.advanceTimersByTime(100))
      fireEvent.pointerEnter(tank, { pointerType: 'mouse' })
      act(() => vi.advanceTimersByTime(300))
      expect(screen.getByRole('dialog')).toBeTruthy()
      fireEvent.pointerLeave(tank, { pointerType: 'mouse' })
      act(() => vi.advanceTimersByTime(250))
      expect(screen.queryByRole('dialog')).toBeNull()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('pins a hovered panel once it is used, and shows only the hovered one over a pinned one', () => {
    vi.useFakeTimers()
    try {
      render(<TowerHome onUnavailable={vi.fn()} />)
      const light = chip('85%').parentElement as HTMLElement
      fireEvent.pointerEnter(light, { pointerType: 'mouse' })
      const panel = screen.getByRole('dialog', { name: '85%' })
      expect(panel.textContent).toContain('Grow light · on schedule')
      fireEvent.pointerDown(within(panel).getByLabelText('Brightness'))
      fireEvent.pointerLeave(light, { pointerType: 'mouse' })
      act(() => vi.advanceTimersByTime(250))
      expect(screen.getByRole('dialog', { name: '85%' })).toBeTruthy()
      const air = chip('22.5°C · 51%').parentElement as HTMLElement
      fireEvent.pointerEnter(air, { pointerType: 'mouse' })
      expect(screen.getAllByRole('dialog').map(d => d.getAttribute('aria-label'))).toEqual(['22.5°C · 51%'])
      fireEvent.pointerLeave(air, { pointerType: 'mouse' })
      act(() => vi.advanceTimersByTime(250))
      expect(screen.getByRole('dialog', { name: '85%' })).toBeTruthy()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('closes a pinned panel on a click outside it, and ignores touch hovers', () => {
    render(<TowerHome onUnavailable={vi.fn()} />)
    fireEvent.click(chip('85%'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(within(screen.getByRole('dialog')).getByLabelText('Brightness'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.pointerEnter(chip('85%').parentElement as HTMLElement, { pointerType: 'touch' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
