// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlantMountOptions } from '../plantRenderer'
import { PlantModel } from '../PlantModel'
import { clearThumbs } from '../plantThumbs'

const { mounted } = vi.hoisted(() => ({ mounted: { opts: null as PlantMountOptions | null, shown: [] as string[], disposed: 0, fail: false } }))

vi.mock('../plantRenderer', () => ({
  mountPlant: (_host: HTMLElement, opts: PlantMountOptions) => {
    if (mounted.fail) throw new Error('no context')
    mounted.opts = opts
    return { show: (s: string) => mounted.shown.push(s), dispose: () => mounted.disposed++ }
  },
  renderPlantImage: () => {
    throw new Error('no context')
  },
}))

const slider = () => screen.getByRole('slider', { name: 'Growth stage' })

beforeEach(() => {
  clearThumbs()
  Object.assign(mounted, { opts: null, shown: [], disposed: 0, fail: false })
  vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PlantModel', () => {
  it('turns the pod\'s plant on today\'s stage, scrubs to harvest, and frees it on unmount', async () => {
    const { unmount } = render(<PlantModel plant="Basil" today="young" seed={7} />)
    await waitFor(() => expect(mounted.shown).toEqual(['young']))
    expect(mounted.opts).toMatchObject({ plant: 'Basil', seed: 7, turn: true })
    expect(slider().getAttribute('aria-valuetext')).toBe('young (today)')
    expect(screen.getByText('young · today').className).toContain('text-fg')
    expect(screen.queryByText('generic model')).toBeNull()
    fireEvent.change(slider(), { target: { value: '3' } })
    expect(mounted.shown).toEqual(['young', 'full'])
    expect(slider().getAttribute('aria-valuetext')).toBe('harvest')
    expect(screen.getByText('harvest').className).toContain('text-fg')
    fireEvent.change(slider(), { target: { value: '0' } })
    expect(mounted.shown.at(-1)).toBe('sprout')
    expect(screen.getByText('seedling')).toBeTruthy()
    unmount()
    expect(mounted.disposed).toBe(1)
  })

  it('holds still under prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' }))
    render(<PlantModel plant="Kale" today="bush" seed={1} />)
    await waitFor(() => expect(mounted.opts?.turn).toBe(false))
  })

  it('labels the generic model for a plant the catalog does not know', async () => {
    render(<PlantModel plant="Mystery seed" today="bush" seed={2} />)
    expect(screen.getByText('generic model')).toBeTruthy()
    await waitFor(() => expect(mounted.shown).toEqual(['bush']))
  })

  it('shows the still in its place without WebGL, and the scrubber still steps it', () => {
    vi.unstubAllGlobals()
    render(<PlantModel plant="Basil" today="bush" seed={1} />)
    expect(screen.getByTestId('plant-thumb').style.width).toBe('88px')
    fireEvent.change(slider(), { target: { value: '3' } })
    expect(slider().getAttribute('aria-valuetext')).toBe('harvest')
    expect(mounted.opts).toBeNull()
  })

  it('falls back to the still when the context fails to start or is lost', async () => {
    mounted.fail = true
    const { unmount } = render(<PlantModel plant="Basil" today="bush" seed={1} />)
    await waitFor(() => expect(screen.getByTestId('plant-thumb')).toBeTruthy())
    unmount()
    mounted.fail = false
    render(<PlantModel plant="Basil" today="bush" seed={1} />)
    await waitFor(() => expect(mounted.opts).not.toBeNull())
    act(() => mounted.opts?.onFail())
    expect(screen.getByTestId('plant-thumb')).toBeTruthy()
    expect(mounted.disposed).toBe(1)
  })
})
