// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardsHome, Dashboard } from '../Dashboard'

interface Hook { onSuccess?: (r: unknown) => void, onSettled?: () => void }

const { data, mutations, setData, invalidatePump } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  /** Per path: the hook's callbacks, the last mutate input, and what the mutation shows while pending. */
  mutations: new Map<string, { hook?: Hook, input?: unknown, count: number, pending?: unknown }>(),
  setData: vi.fn(),
  invalidatePump: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a>{children as string}</a>, useNavigate: () => vi.fn() }))

// Every procedure answers useQuery with data keyed by its path, and useMutation by recording its calls.
vi.mock('@/src/utils/trpc', () => {
  const proc = (path: string) => ({
    useQuery: () => ({ data: data.get(path), refetch: vi.fn() }),
    useMutation: (hook?: Hook) => {
      const m = mutations.get(path) ?? { count: 0 }
      mutations.set(path, { ...m, hook })
      return {
        mutate: (input: unknown) => {
          const now = mutations.get(path)
          mutations.set(path, { ...now, input, count: (now?.count ?? 0) + 1 })
        },
        isPending: m.pending !== undefined,
        variables: m.pending,
        error: null,
      }
    },
  })
  const router = (prefix: string): unknown => new Proxy({}, { get: (_, k: string) => (k === 'useQuery' || k === 'useMutation' ? proc(prefix)[k] : router(prefix ? `${prefix}.${k}` : k)) })
  return { apiBase: () => '', trpc: new Proxy({}, { get: (_, k: string) => (k === 'useUtils' ? () => ({ settings: { invalidate: vi.fn() }, light: { get: { setData: (_: unknown, v: unknown) => setData('light', v) } }, pump: { invalidate: invalidatePump, get: { setData: (_: unknown, v: unknown) => setData('pump', v) } } }) : router(k)) }) }
})

describe('readings on the cards Home', () => {
  const at = (msAgo: number, quality = 'good') => ({ ts: new Date(Date.now() - msAgo).toISOString(), value: 7, unit: 'cm', quality })
  const age = (label: string) => within(screen.getByText(label).parentElement as HTMLElement).getByTestId('reading-age')

  it('shows each reading\'s age, and says when there is none', () => {
    data.set('sensors.latest', { water_distance: at(8_000) })
    render(<CardsHome />)
    expect(age('Distance').textContent).toMatch(/^updated \ds ago$/)
    expect(age('Tank').textContent).toBe('no reading')
    expect(age('Tank').className).not.toContain('text-warn')
  })

  it('marks a reading that stopped arriving, and one hald flagged as suspect', () => {
    data.set('sensors.latest', { water_distance: at(90_000), air_temp: at(1_000, 'suspect') })
    render(<CardsHome />)
    expect(age('Distance').textContent).toBe('stale · updated 1m ago')
    expect(age('Distance').className).toContain('text-warn')
    expect(age('Air').textContent).toMatch(/^suspect · updated \ds ago$/)
    expect(age('Air').className).toContain('text-warn')
  })
})

afterEach(() => {
  cleanup()
  data.clear()
  mutations.clear()
  setData.mockReset()
  invalidatePump.mockReset()
})

describe('Dashboard', () => {
  it('opens on Welcome until the unit is set up', () => {
    data.set('settings.get', { setupComplete: false })
    render(<Dashboard />)
    expect(screen.getByText('Welcome to seedypod')).toBeTruthy()
    expect(screen.queryByText('Grow light')).toBeNull()
  })

  it('shows the cards Home, with active alerts such as backup_stale, where there is no WebGL (jsdom)', async () => {
    data.set('settings.get', { setupComplete: true })
    data.set('alerts.list', [{ id: 1, kind: 'backup_stale', active: true, detail: 'No off-card backup yet.' }])
    render(<Dashboard />)
    expect(await screen.findByText('Grow light')).toBeTruthy()
    expect(screen.getByText('backup_stale: No off-card backup yet.')).toBeTruthy()
  })

  describe('cards Home controls', () => {
    const lit = { on: true, level: 40, since: '2026-11-01T10:00:00Z', fault: null, remainingS: null }
    const brightness = async () => {
      data.set('settings.get', { setupComplete: true })
      data.set('light.get', lit)
      render(<Dashboard />)
      return await screen.findByLabelText('Brightness') as HTMLInputElement
    }

    it('moves the slider at once and sends one command, on release, however many ticks the drag took', async () => {
      const slider = await brightness()
      for (const value of ['45', '50', '55', '60']) fireEvent.change(slider, { target: { value } })
      expect(slider.value).toBe('60')
      expect(mutations.get('light.set')?.count ?? 0).toBe(0)
      fireEvent.pointerUp(slider)
      expect(mutations.get('light.set')).toMatchObject({ count: 1, input: { level: 60 } })
    })

    it('holds the released level until the Pi has answered, so the slider never jumps back', async () => {
      const slider = await brightness()
      fireEvent.change(slider, { target: { value: '60' } })
      fireEvent.pointerUp(slider)
      expect(slider.value).toBe('60')
      data.set('light.get', { ...lit, level: 60 })
      act(() => mutations.get('light.set')?.hook?.onSettled?.())
      expect(slider.value).toBe('60')
    })

    it('goes back to the server\'s level when the command is refused', async () => {
      const slider = await brightness()
      fireEvent.change(slider, { target: { value: '60' } })
      fireEvent.pointerUp(slider)
      act(() => mutations.get('light.set')?.hook?.onSettled?.())
      expect(slider.value).toBe('40')
    })

    it('lets go of the draft even when a power tap replaced the brightness command in flight', async () => {
      const slider = await brightness()
      fireEvent.change(slider, { target: { value: '60' } })
      fireEvent.pointerUp(slider)
      fireEvent.click(screen.getByText('Turn off'))
      expect(mutations.get('light.set')).toMatchObject({ count: 2, input: { on: false } })
      act(() => mutations.get('light.set')?.hook?.onSettled?.())
      expect(slider.value).toBe('40')
    })

    it('flips the button with the tap, from the tapped value while the command is in flight', async () => {
      await brightness()
      fireEvent.click(screen.getByText('Turn off'))
      expect(mutations.get('light.set')?.input).toEqual({ on: false })
      cleanup()
      mutations.set('light.set', { count: 0, pending: { on: false } })
      await brightness()
      expect(screen.getByText('Turn on')).toBeTruthy()
      cleanup()
      mutations.set('light.set', { count: 0, pending: { level: 10 } })
      await brightness()
      expect(screen.getByText('Turn off')).toBeTruthy()
    })

    it('writes the light a command returns into the cache instead of fetching it again', async () => {
      await brightness()
      mutations.get('light.set')?.hook?.onSuccess?.(lit)
      expect(setData).toHaveBeenCalledWith('light', lit)
    })

    it('asks the server for the pump after each command, since a late reply could be older than the cache', async () => {
      await brightness()
      mutations.get('pump.runOnce')?.hook?.onSuccess?.({ ...lit, level: 30 })
      expect(invalidatePump).toHaveBeenCalledTimes(1)
      mutations.get('pump.stop')?.hook?.onSuccess?.({ ...lit, on: false })
      expect(invalidatePump).toHaveBeenCalledTimes(2)
      expect(setData).not.toHaveBeenCalled()
    })
  })
})
