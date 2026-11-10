// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSED_KEY, Sidebar } from '../Sidebar'

const { data, path } = vi.hoisted(() => ({ data: new Map<string, unknown>(), path: { current: '/' } }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, ...rest }: { children: unknown, to: string, search?: { pod?: number } }) => <a href={search?.pod ? `${to}?pod=${search.pod}` : to} {...rest}>{children as string}</a>,
  useLocation: () => ({ pathname: path.current }),
}))
vi.mock('@/src/components/Search/CommandPalette', () => ({ SidebarSearch: () => <div>Search</div> }))

vi.mock('@/src/utils/trpc', () => {
  const proc = (p: string) => ({ useQuery: () => ({ data: data.get(p) }) })
  const router = (prefix: string): unknown => new Proxy({}, { get: (_, k: string) => (k === 'useQuery' ? proc(prefix).useQuery : router(prefix ? `${prefix}.${k}` : k)) })
  return { trpc: router('') }
})

const pod = (slot: number, status: string, plant: string | null, notes = '') => ({ slot, status, plant, notes, plantedAt: null, updatedAt: '', statusSince: null, lastHarvestAt: null })
const online = { name: 'Kitchen Gardyn', line: 'gardyn 3.0 · core dev · online', online: true }

afterEach(() => {
  cleanup()
  data.clear()
  path.current = '/'
  localStorage.clear()
  vi.restoreAllMocks()
})

const aside = () => screen.getByRole('complementary')

describe('Sidebar', () => {
  it('links the brand icon and name home', () => {
    const { container } = render(<Sidebar status={online} />)
    const home = screen.getByText('seedypod').closest('a') as HTMLElement
    expect(home.getAttribute('href')).toBe('/')
    expect(container.querySelector('a[href="/"] img')?.getAttribute('src')).toBe('/brand/icon-64.png')
  })

  it('shows light, tank and air on every page, each linking to its page', () => {
    data.set('light.get', { on: true, level: 49 })
    data.set('sensors.latest', { water_level_pct: { value: 71, unit: '%' }, air_temp: { value: 25.5, unit: '°C' }, humidity: { value: 55, unit: '%' } })
    render(<Sidebar status={online} />)
    expect(screen.getByText('49%').closest('a')?.getAttribute('href')).toBe('/light')
    expect(screen.getByText('71%').closest('a')?.getAttribute('href')).toBe('/water')
    expect(screen.getByText('26°C · 55%').closest('a')?.getAttribute('href')).toBe('/sensors')
    expect(screen.queryByText('Tank · watering')).toBeNull()
  })

  it('says the tank is watering while the pump runs', () => {
    data.set('sensors.latest', { water_level_pct: { value: 71, unit: '%' } })
    data.set('pump.get', { on: true, level: 30, remainingS: 200 })
    render(<Sidebar status={online} />)
    expect(screen.getByText('Tank · watering').closest('a')?.getAttribute('href')).toBe('/water')
  })

  it('says how old the readings are once, at the bottom, and nothing on fresh rows', () => {
    const ts = new Date(Date.now() - 8_000).toISOString()
    data.set('light.get', { on: true, level: 49 })
    data.set('sensors.latest', { water_level_pct: { ts, value: 71, unit: '%', quality: 'good' }, air_temp: { ts, value: 25.5, unit: '°C', quality: 'good' } })
    render(<Sidebar status={online} />)
    const updated = screen.getAllByTestId('readings-updated')
    expect(updated).toHaveLength(1)
    expect(updated[0]?.textContent).toMatch(/^updated \ds ago$/)
    expect(updated[0]?.className).toContain('text-fg-3')
    expect(screen.getByText('Kitchen Gardyn').closest('a')?.contains(updated[0] ?? null)).toBe(true)
    expect(screen.queryByTestId('reading-age')).toBeNull()
    expect(screen.queryByTestId('reading-flag')).toBeNull()
  })

  it('marks only the row whose sensor stopped reporting, and dates the bottom line by the newest', () => {
    data.set('sensors.latest', {
      water_level_pct: { ts: new Date(Date.now() - 5 * 60_000).toISOString(), value: 71, unit: '%', quality: 'good' },
      air_temp: { ts: new Date(Date.now() - 4_000).toISOString(), value: 25.5, unit: '°C', quality: 'good' },
    })
    render(<Sidebar status={online} />)
    const flag = within(screen.getByText('71%').closest('a') as HTMLElement).getByTestId('reading-flag')
    expect(flag.textContent).toBe('stale')
    expect(flag.className).toContain('text-warn')
    expect(within(screen.getByText('26°C').closest('a') as HTMLElement).queryByTestId('reading-flag')).toBeNull()
    expect(screen.getAllByTestId('reading-flag')).toHaveLength(1)
    expect(screen.getByTestId('readings-updated').textContent).toMatch(/^updated \ds ago$/)
  })

  it('turns the bottom line amber once every reading has gone quiet, and drops it with none', () => {
    data.set('sensors.latest', { water_level_pct: { ts: new Date(Date.now() - 5 * 60_000).toISOString(), value: 71, unit: '%', quality: 'suspect' } })
    const { rerender } = render(<Sidebar status={online} />)
    const updated = screen.getByTestId('readings-updated')
    expect(updated.textContent).toBe('updated 5m ago')
    expect(updated.className).toContain('text-warn')
    data.delete('sensors.latest')
    rerender(<Sidebar status={online} />)
    expect(screen.queryByTestId('readings-updated')).toBeNull()
  })

  it('flags a suspect reading on its row', () => {
    data.set('sensors.latest', { humidity: { ts: new Date().toISOString(), value: 55, unit: '%', quality: 'suspect' } })
    render(<Sidebar status={online} />)
    expect(within(screen.getByText('55%').closest('a') as HTMLElement).getByTestId('reading-flag').textContent).toBe('suspect')
  })

  it('reads the light as off, and dashes for missing readings', () => {
    data.set('light.get', { on: false, level: 80 })
    render(<Sidebar status={online} />)
    expect(screen.getByText('off')).toBeTruthy()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('adds a water line for installed water-quality probes only', () => {
    data.set('sensors.latest', { ph: { value: 6.1, unit: 'pH' }, ec: { value: 1.4, unit: 'mS/cm' } })
    data.set('system.info', { system: { caps: { sensors: ['air_temp', 'ph', 'ec'] } } })
    const { rerender } = render(<Sidebar status={online} />)
    expect(screen.getByText('pH 6.1 · EC 1.4 mS/cm').closest('a')?.getAttribute('href')).toBe('/sensors')
    data.set('system.info', { system: { caps: { sensors: ['air_temp'] } } })
    rerender(<Sidebar status={online} />)
    expect(screen.queryByText(/^pH /)).toBeNull()
  })

  it('lists each pod needing attention, then those ready to harvest as one line', () => {
    data.set('grow.pods', [pod(9, 'attention', 'Red Russian Kale', 'Yellowing lower leaves'), pod(1, 'harvest', 'Swiss Chard'), pod(2, 'growing', 'Arugula'), pod(3, 'growing', 'Dill'), pod(4, 'harvest', null), pod(5, 'growing', 'Mint')])
    data.set('grow.harvest', [{ slot: 2, state: 'ready' }, { slot: 3, state: 'ready' }])
    render(<Sidebar status={online} />)
    expect(screen.getByText('Needs you')).toBeTruthy()
    expect(screen.getByText('Red Russian Kale').closest('a')?.getAttribute('href')).toBe('/grow?pod=9')
    expect(screen.getByText('Yellowing lower leaves')).toBeTruthy()
    expect(screen.getByText('P9')).toBeTruthy()
    expect(screen.getByText('4 ready to harvest')).toBeTruthy()
    expect(screen.getByText('Swiss Chard, Arugula, +2')).toBeTruthy()
    // The pod needing attention carries its plant's picture; the harvest line, which names several, a dot.
    const thumbs = document.querySelectorAll<HTMLElement>('[data-testid="plant-thumb"]')
    expect(thumbs).toHaveLength(1)
    expect(screen.getByText('Red Russian Kale').closest('a')?.contains(thumbs[0] ?? null)).toBe(true)
    expect(thumbs[0]?.style.width).toBe('32px')
  })

  it('says why a pod needs attention when it has no note, and hides the section when nothing needs doing', () => {
    data.set('grow.pods', [pod(9, 'attention', null), pod(2, 'harvest', 'Arugula')])
    const { rerender } = render(<Sidebar status={online} />)
    expect(screen.getByText('Pod 9')).toBeTruthy()
    expect(screen.getByText('Needs attention')).toBeTruthy()
    expect(screen.getByText('Arugula')).toBeTruthy()
    data.set('grow.pods', [pod(2, 'growing', 'Arugula')])
    rerender(<Sidebar status={online} />)
    expect(screen.queryByText('Needs you')).toBeNull()
  })

  it('lists chores that are due, from a reading or marked as a calendar guess (ADR-0029)', () => {
    data.set('care.chores', [
      { id: 'top_off', title: 'Top off the tank', state: 'due', basis: 'reading', reason: 'Tank at 40%, falling 8% a day: below half, so top it off.' },
      { id: 'thin', title: 'Thin seedlings', state: 'due', basis: 'timeline', reason: 'Calendar guess, no recent photos of the young pods: 15 d since the oldest young pod was planted.' },
      { id: 'feed', title: 'Feed', state: 'soon', basis: 'reading', reason: 'EC 1.25' },
    ])
    render(<Sidebar status={online} />)
    expect(screen.getByText('Needs you')).toBeTruthy()
    const top = screen.getByText('Top off the tank').closest('a') as HTMLElement
    expect(top.getAttribute('href')).toBe('/care')
    expect(within(top).getByText(/Tank at 40%, falling 8% a day/)).toBeTruthy()
    expect(within(top).queryByText('calendar')).toBeNull()
    const thin = screen.getByText('Thin seedlings').closest('a') as HTMLElement
    expect(thin.getAttribute('href')).toBe('/care')
    expect(within(thin).getByText('calendar')).toBeTruthy()
    expect(screen.queryByText('Feed')).toBeNull()
  })

  it('groups the pages, marks the current one, and carries the cycle, Autopilot and alert count', () => {
    path.current = '/grow'
    data.set('grow.current', { cycle: { stage: 'vegetative' }, day: 19 })
    data.set('automations.status', { enabled: true })
    data.set('alerts.list', [{ active: true }, { active: true }, { active: false }])
    render(<Sidebar status={online} />)
    for (const g of ['Garden', 'Control', 'Observe', 'System']) expect(screen.getByText(g)).toBeTruthy()
    const grow = screen.getByText('Grow').closest('a') as HTMLElement
    expect(grow.getAttribute('aria-current')).toBe('page')
    expect(within(grow).getByText('Day 19')).toBeTruthy()
    expect(within(grow).getByLabelText('Stage: vegetative').children).toHaveLength(4)
    expect(screen.getByText('Home').closest('a')?.getAttribute('aria-current')).toBeNull()
    expect(screen.getByLabelText('Autopilot on')).toBeTruthy()
    expect(within(screen.getByText('Alerts').closest('a') as HTMLElement).getByText('2')).toBeTruthy()
  })

  it('counts the system checks passing on Status, coloured by the worst one', () => {
    const checks = (states: string[]) => ({ checks: states.map((state, i) => ({ id: `c${i}`, label: '', state, detail: '', since: null })) })
    data.set('system.checks', checks(['ok', 'idle', 'ok']))
    const { rerender } = render(<Sidebar status={online} />)
    const status = screen.getByText('Status').closest('a') as HTMLElement
    expect(status.getAttribute('href')).toBe('/status')
    expect(within(status).getByLabelText('3 of 3 checks passing').textContent).toBe('3/3')
    expect(within(status).getByText('3/3').className).toContain('text-fg-3')
    data.set('system.checks', checks(['ok', 'stalled', 'ok']))
    rerender(<Sidebar status={online} />)
    expect(within(status).getByText('2/3').className).toContain('text-pod-ready')
    data.set('system.checks', checks(['ok', 'down', 'ok', 'stalled']))
    rerender(<Sidebar status={online} />)
    expect(within(status).getByText('2/4').className).toContain('text-pod-attention')
  })

  it('leaves out the cycle, dot and badge when there is none, and names the unit in the footer', () => {
    data.set('automations.status', { enabled: false })
    render(<Sidebar status={{ name: 'Kitchen Gardyn', line: 'core unreachable', online: false }} />)
    expect(screen.queryByText(/^Day /)).toBeNull()
    expect(screen.queryByLabelText('Autopilot on')).toBeNull()
    expect(screen.queryByLabelText(/checks passing/)).toBeNull()
    expect(screen.getByText('Kitchen Gardyn')).toBeTruthy()
    expect(screen.getByText('core unreachable')).toBeTruthy()
  })

  it('folds a nav group from its header, and remembers it across a remount', () => {
    const { unmount } = render(<Sidebar status={online} />)
    const observe = within(aside()).getByRole('button', { name: 'Observe' })
    expect(observe.getAttribute('aria-expanded')).toBe('true')
    expect(observe.getAttribute('aria-controls')).toBe('nav-observe')
    fireEvent.click(observe)
    expect(observe.getAttribute('aria-expanded')).toBe('false')
    expect(within(aside()).queryByRole('link', { name: 'Cameras' })).toBeNull()
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual(['observe'])
    unmount()
    render(<Sidebar status={online} />)
    expect(within(aside()).getByRole('button', { name: 'Observe' }).getAttribute('aria-expanded')).toBe('false')
    expect(within(aside()).queryByRole('link', { name: 'Analysis' })).toBeNull()
    expect(within(aside()).getByRole('link', { name: 'Home' })).toBeTruthy()
    fireEvent.click(within(aside()).getByRole('button', { name: 'Observe' }))
    expect(within(aside()).getByRole('link', { name: 'Cameras' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual([])
  })

  it('keeps the current page visible inside a folded group', () => {
    path.current = '/analysis'
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['observe', 7]))
    render(<Sidebar status={online} />)
    expect(within(aside()).getByRole('link', { name: 'Analysis' }).getAttribute('aria-current')).toBe('page')
    expect(within(aside()).queryByRole('link', { name: 'Cameras' })).toBeNull()
  })

  it('opens every group when the saved choice is unreadable or storage is blocked', () => {
    localStorage.setItem(COLLAPSED_KEY, '{nope')
    const { unmount } = render(<Sidebar status={online} />)
    expect(within(aside()).getByRole('link', { name: 'Cameras' })).toBeTruthy()
    unmount()
    localStorage.setItem(COLLAPSED_KEY, '{"observe":true}')
    const second = render(<Sidebar status={online} />)
    expect(within(aside()).getByRole('link', { name: 'Cameras' })).toBeTruthy()
    second.unmount()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<Sidebar status={online} />)
    fireEvent.click(within(aside()).getByRole('button', { name: 'Control' }))
    expect(within(aside()).queryByRole('link', { name: 'Light' })).toBeNull()
  })

  it('links the docs in a new tab, and the unit row to Status', () => {
    render(<Sidebar status={online} />)
    const docs = within(aside()).getByRole('link', { name: 'Docs' })
    expect(docs.getAttribute('href')).toBe('https://seedypod.github.io')
    expect(docs.getAttribute('target')).toBe('_blank')
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer')
    expect(within(aside()).getByText('Kitchen Gardyn').closest('a')?.getAttribute('href')).toBe('/status')
  })
})
