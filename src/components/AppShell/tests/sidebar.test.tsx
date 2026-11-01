// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../Sidebar'

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
})

describe('Sidebar', () => {
  it('shows light, tank and air on every page, each linking to its page', () => {
    data.set('light.get', { on: true, level: 49 })
    data.set('sensors.latest', { water_level_pct: { value: 71, unit: '%' }, air_temp: { value: 25.5, unit: '°C' }, humidity: { value: 55, unit: '%' } })
    render(<Sidebar status={online} />)
    expect(screen.getByText('49%').closest('a')?.getAttribute('href')).toBe('/light')
    expect(screen.getByText('71%').closest('a')?.getAttribute('href')).toBe('/water')
    expect(screen.getByText('25.5°C · 55%').closest('a')?.getAttribute('href')).toBe('/sensors')
  })

  it('reads the light as off, and dashes for missing readings', () => {
    data.set('light.get', { on: false, level: 80 })
    render(<Sidebar status={online} />)
    expect(screen.getByText('off')).toBeTruthy()
    expect(screen.getAllByText('—')).toHaveLength(2)
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

  it('groups the pages, marks the current one, and carries the cycle, Autopilot and alert count', () => {
    path.current = '/grow'
    data.set('grow.current', { cycle: { stage: 'vegetative' }, day: 19 })
    data.set('automations.status', { enabled: true })
    data.set('alerts.list', [{ active: true }, { active: true }, { active: false }])
    render(<Sidebar status={online} />)
    for (const g of ['Garden', 'Control', 'Observe']) expect(screen.getByText(g)).toBeTruthy()
    const grow = screen.getByText('Grow').closest('a') as HTMLElement
    expect(grow.getAttribute('aria-current')).toBe('page')
    expect(within(grow).getByText('Day 19')).toBeTruthy()
    expect(within(grow).getByLabelText('Stage: vegetative').children).toHaveLength(4)
    expect(screen.getByText('Home').closest('a')?.getAttribute('aria-current')).toBeNull()
    expect(screen.getByLabelText('Autopilot on')).toBeTruthy()
    expect(within(screen.getByText('Alerts').closest('a') as HTMLElement).getByText('2')).toBeTruthy()
  })

  it('leaves out the cycle, dot and badge when there is none, and names the unit in the footer', () => {
    data.set('automations.status', { enabled: false })
    render(<Sidebar status={{ name: 'Kitchen Gardyn', line: 'core unreachable', online: false }} />)
    expect(screen.queryByText(/^Day /)).toBeNull()
    expect(screen.queryByLabelText('Autopilot on')).toBeNull()
    expect(screen.getByText('Kitchen Gardyn')).toBeTruthy()
    expect(screen.getByText('core unreachable')).toBeTruthy()
  })
})
