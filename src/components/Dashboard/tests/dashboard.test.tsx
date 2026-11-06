// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dashboard } from '../Dashboard'

interface Hook { onMutate?: () => unknown, onSuccess?: (r: unknown, sent?: unknown, context?: unknown) => void, onError?: (e: Error, sent: unknown) => void, onSettled?: () => void }

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
          hook?.onMutate?.()
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

    const adjust = (slider: HTMLInputElement, ...values: string[]) => {
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      for (const value of values) fireEvent.input(slider, { target: { value } })
    }

    it('moves the slider at once and sends one command, on release, however many ticks the adjustment took', async () => {
      const slider = await brightness()
      adjust(slider, '45', '50', '55', '60')
      expect(slider.value).toBe('60')
      expect(mutations.get('light.set')?.count ?? 0).toBe(0)
      fireEvent.keyUp(slider, { key: 'ArrowRight' })
      expect(mutations.get('light.set')).toMatchObject({ count: 1, input: { level: 60 } })
    })

    it('holds the requested level past the answer until the light reports it, so a fade never drags the slider', async () => {
      const slider = await brightness()
      adjust(slider, '60')
      fireEvent.keyUp(slider, { key: 'ArrowRight' })
      expect(slider.value).toBe('60')
      expect(screen.getByText(/^60% since/)).toBeTruthy()
      // The light fades up through 50 on its way.
      data.set('light.get', { ...lit, level: 50 })
      act(() => mutations.get('light.set')?.hook?.onSuccess?.({ ...lit, level: 50 }, { level: 60 }, { command: 1 }))
      expect(slider.value).toBe('60')
    })

    it('goes back to the server\'s level when the command is refused', async () => {
      const slider = await brightness()
      adjust(slider, '60')
      fireEvent.keyUp(slider, { key: 'ArrowRight' })
      act(() => mutations.get('light.set')?.hook?.onError?.(new Error('refused'), { level: 60 }))
      expect(slider.value).toBe('40')
    })

    it('lets go of the requested level when the power button overrides it', async () => {
      const slider = await brightness()
      adjust(slider, '60')
      fireEvent.keyUp(slider, { key: 'ArrowRight' })
      fireEvent.click(screen.getByText('Turn off'))
      expect(mutations.get('light.set')).toMatchObject({ count: 2, input: { on: false } })
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
      const context = mutations.get('light.set')?.hook?.onMutate?.()
      mutations.get('light.set')?.hook?.onSuccess?.(lit, { level: 40 }, context)
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
