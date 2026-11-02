// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedThumb, clearThumbs, plantThumb, thumbKey, THUMB_PX } from '../plantThumbs'
import { PlantThumb, podForm } from '../PlantThumb'

const { draw } = vi.hoisted(() => ({ draw: { calls: [] as unknown[][], fail: false } }))

vi.mock('../plantRenderer', () => ({
  renderPlantImage: (...args: unknown[]) => {
    draw.calls.push(args)
    if (draw.fail) throw new Error('no context')
    return `data:image/png;base64,${String(args[0])}|${String(args[1])}|${String(args[2])}`
  },
}))

const webGL = () => vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})

beforeEach(() => {
  clearThumbs()
  Object.assign(draw, { calls: [], fail: false })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

describe('plant thumbnails', () => {
  it('keys a still by catalog entry, stage and theme, and has none for an unknown plant', () => {
    expect(thumbKey('Genovese Basil', 'bush', false)).toBe('Basil|bush|dark')
    expect(thumbKey('Basil', 'bush', false)).toBe(thumbKey('Genovese Basil', 'bush', false))
    expect(thumbKey('Basil', 'full', false)).toBe('Basil|full|dark')
    expect(thumbKey('Basil', 'bush', true)).toBe('Basil|bush|light')
    expect(thumbKey('Mystery seed', 'bush', false)).toBeNull()
    expect(thumbKey(null, 'bush', false)).toBeNull()
  })

  it('renders each still once and shares it', async () => {
    webGL()
    const [a, b] = await Promise.all([plantThumb('Basil', 'bush', false), plantThumb('Genovese Basil', 'bush', false)])
    expect(a).toBe('data:image/png;base64,Basil|bush|false')
    expect(b).toBe(a)
    expect(draw.calls).toEqual([['Basil', 'bush', false, THUMB_PX]])
    expect(cachedThumb('Basil|bush|dark')).toBe(a)
    expect(cachedThumb('Basil|full|dark')).toBeNull()
    expect(cachedThumb(null)).toBeNull()
    await plantThumb('Basil', 'full', true)
    expect(draw.calls).toHaveLength(2)
  })

  it('never renders the generic model, nor anything without WebGL', async () => {
    webGL()
    expect(await plantThumb('Mystery seed', 'bush', false)).toBeNull()
    vi.unstubAllGlobals()
    expect(await plantThumb('Basil', 'bush', false)).toBeNull()
    expect(draw.calls).toHaveLength(0)
  })

  it('gives up after a failed render, until cleared', async () => {
    webGL()
    draw.fail = true
    expect(await plantThumb('Kale', 'young', false)).toBeNull()
    expect(await plantThumb('Mint', 'young', false)).toBeNull()
    expect(draw.calls).toHaveLength(1)
    clearThumbs()
    draw.fail = false
    expect(await plantThumb('Mint', 'young', false)).toContain('Mint')
  })
})

describe('podForm', () => {
  it('draws a pod at the stage the tower does', () => {
    expect(podForm({ status: 'empty' })).toBe('none')
    expect(podForm({ status: 'seeded' })).toBe('sprout')
    expect(podForm({ status: 'growing', green: 0.05 })).toBe('young')
    expect(podForm({ status: 'growing', green: 0.4 })).toBe('bush')
    expect(podForm({ status: 'attention', ageDays: 30 })).toBe('bush')
    expect(podForm({ status: 'harvest' })).toBe('full')
  })
})

describe('PlantThumb', () => {
  const thumb = () => screen.getByTestId('plant-thumb')

  it('shows a neutral leaf without WebGL, as in jsdom', () => {
    render(<PlantThumb plant="Basil" stage="bush" />)
    expect(thumb().dataset.kind).toBe('neutral')
    expect(thumb().style.width).toBe('36px')
    expect(thumb().querySelector('svg')).toBeTruthy()
    expect(draw.calls).toHaveLength(0)
  })

  it('shows an empty ring for an empty pod', () => {
    webGL()
    render(<PlantThumb plant="Basil" stage="none" size={32} />)
    expect(thumb().dataset.kind).toBe('empty')
    expect(thumb().querySelector('svg, img')).toBeNull()
    expect(draw.calls).toHaveLength(0)
  })

  it('keeps the neutral leaf for a plant the catalog does not know, never the generic model', async () => {
    webGL()
    render(<PlantThumb plant="Mystery seed" stage="bush" />)
    await act(async () => {})
    expect(thumb().dataset.kind).toBe('neutral')
    expect(draw.calls).toHaveLength(0)
  })

  it('swaps in the model still once rendered, shows it at once on a remount, and follows the theme', async () => {
    webGL()
    const { unmount } = render(<PlantThumb plant="Red Russian Kale" stage="young" size={40} />)
    await waitFor(() => expect(thumb().dataset.kind).toBe('model'))
    expect(thumb().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,Kale|young|false')
    unmount()
    render(<PlantThumb plant="Kale" stage="young" size={40} />)
    expect(thumb().dataset.kind).toBe('model')
    expect(draw.calls).toHaveLength(1)
    document.documentElement.dataset.theme = 'light'
    await waitFor(() => expect(thumb().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,Kale|young|true'))
    expect(draw.calls).toHaveLength(2)
  })
})
