// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { Sprout } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '@/src/lib/eventBus'
import { present, useSnackbars } from '../useSnackbars'

const { route, alerts, shown } = vi.hoisted(() => ({
  route: { pathname: '/', navigate: vi.fn() },
  alerts: { data: undefined as Array<{ id: number, kind: string, detail: string }> | undefined },
  shown: [] as Array<{ id: string, title: unknown, urgent?: boolean, action?: { label: string, onClick: () => void } }>,
}))

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => route.navigate,
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: { alerts: { list: { useQuery: () => ({ data: alerts.data }) } } } }))
vi.mock('@/src/components/ds/toast', () => {
  const show = (n: (typeof shown)[number]) => shown.push(n)
  return { useToast: () => ({ show }) }
})

beforeEach(() => {
  route.pathname = '/'
  route.navigate.mockReset()
  alerts.data = undefined
  shown.length = 0
})
afterEach(cleanup)

const follow: CoreEvent = { kind: 'schedule', action: 'changed', id: 'follow:young' }

describe('present', () => {
  const snack = { id: 'follow', tone: 'cool' as const, icon: Sprout, title: 'Watering moved to Young plants', view: { to: '/water', label: 'View' }, shownOn: '/alerts' }

  it('gives the toast a View that opens the snack\'s page', () => {
    const go = vi.fn()
    const t = present(snack, '/grow', go)
    expect(t).toMatchObject({ id: 'follow', kind: 'info', tone: 'cool', title: 'Watering moved to Young plants', action: { label: 'View' } })
    t?.action?.onClick()
    expect(go).toHaveBeenCalledWith('/water')
  })

  it('drops the View on the page it would open, and the toast on the page that shows it', () => {
    expect(present(snack, '/water', vi.fn())?.action).toBeUndefined()
    expect(present(snack, '/alerts', vi.fn())).toBeNull()
  })

  it('marks an ok snack as a success', () => {
    expect(present({ ...snack, tone: 'ok' }, '/', vi.fn())?.kind).toBe('success')
  })
})

describe('useSnackbars', () => {
  it('toasts Follow moving the watering on, with a View into Water', () => {
    const { result } = renderHook(() => useSnackbars())
    act(() => result.current(follow))
    expect(shown.map(s => s.title)).toEqual(['Watering moved to Young plants'])
    shown[0]?.action?.onClick()
    expect(route.navigate).toHaveBeenCalledWith({ to: '/water' })
  })

  it('toasts a manual run that ran its course, and nothing for other events', () => {
    const { result } = renderHook(() => useSnackbars())
    const since = new Date().toISOString()
    act(() => {
      result.current({ kind: 'mutation', path: 'actuators.pump' })
      result.current({ kind: 'hal', event: { type: 'actuator', id: 'pump', state: { on: true, level: 30, since, fault: null, remainingS: 0 } } })
      result.current({ kind: 'hal', event: { type: 'actuator', id: 'pump', state: { on: false, level: 30, since, fault: null, remainingS: null } } })
      result.current({ kind: 'mutation', path: 'tank' })
    })
    expect(shown.map(s => s.title)).toEqual(['Watering finished'])
  })

  it('toasts each newly raised alert once, never what was open on arrival', () => {
    alerts.data = [{ id: 1, kind: 'light_fault', detail: 'driver open' }]
    const { rerender } = renderHook(() => useSnackbars())
    expect(shown).toEqual([])
    alerts.data = [{ id: 1, kind: 'light_fault', detail: 'driver open' }, { id: 2, kind: 'pump_fault', detail: 'pump: dry-run' }]
    rerender()
    expect(shown.map(s => [s.title, s.urgent])).toEqual([['Pump stopped: dry-run', true]])
    alerts.data = [...alerts.data]
    rerender()
    expect(shown).toHaveLength(1)
  })

  it('stays quiet on the page that already shows it, by the page at the time', () => {
    alerts.data = []
    const { rerender } = renderHook(() => useSnackbars())
    route.pathname = '/water'
    alerts.data = [{ id: 3, kind: 'water_low', detail: 'refused pump start: water low' }]
    rerender()
    expect(shown).toEqual([])
  })
})
