// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TowerMountOptions } from '../towerRenderer'
import type { TowerState } from '../towerScene'
import { TowerView } from '../TowerView'

const { mounted } = vi.hoisted(() => ({ mounted: { opts: null as TowerMountOptions | null, updates: [] as TowerState[], disposed: 0, fail: false } }))

vi.mock('../towerRenderer', () => ({
  mountTower: (_host: HTMLElement, opts: TowerMountOptions) => {
    if (mounted.fail) throw new Error('no context')
    mounted.opts = opts
    queueMicrotask(opts.onReady)
    return { update: (s: TowerState) => mounted.updates.push(s), dispose: () => mounted.disposed++ }
  },
}))

const pods = [{ slot: 1, status: 'growing' as const, plant: 'Basil', green: 0.42 }, { slot: 2, status: 'empty' as const, plant: null }]

beforeEach(() => {
  Object.assign(mounted, { opts: null, updates: [], disposed: 0, fail: false })
  HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement['getContext']
  vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TowerView', () => {
  it('mounts the renderer, feeds it state and shows the controls and legend', async () => {
    render(<TowerView pods={pods} waterPct={60} lightLevel={70} selected={1} onSelect={vi.fn()} onUnavailable={vi.fn()} controls={<button type="button">85%</button>} />)
    await waitFor(() => expect(mounted.updates.length).toBeGreaterThan(0))
    expect(mounted.opts?.podCount).toBe(2)
    expect(mounted.updates.at(-1)).toMatchObject({ waterPct: 60, lightLevel: 70, selected: 1, hovered: null })
    expect(screen.getByRole('button', { name: '85%' })).toBeTruthy()
    expect(screen.getByText('Ready to harvest')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Loading the tower…')).toBeNull())
  })

  it('names the hovered pod, and a part only where it has a control', async () => {
    const onPart = vi.fn()
    const { rerender } = render(<TowerView pods={pods} waterPct={null} lightLevel={0} onSelect={vi.fn()} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(mounted.opts).not.toBeNull())
    act(() => mounted.opts?.onHover({ kind: 'pod', slot: 1 }))
    expect(screen.getByRole('status').textContent).toBe('Pod 1BasilGrowing · 42% green')
    expect(mounted.updates.at(-1)?.hovered).toBe(1)
    act(() => mounted.opts?.onHover({ kind: 'part', part: 'light' }))
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<TowerView pods={pods} waterPct={null} lightLevel={0} onSelect={vi.fn()} onPart={onPart} partLabels={{ light: 'Grow light · off' }} onUnavailable={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Grow light · offClick to adjust')
  })

  it('passes pod clicks to onSelect and part clicks to onPart', async () => {
    const onSelect = vi.fn()
    const onPart = vi.fn()
    render(<TowerView pods={pods} waterPct={null} lightLevel={0} onSelect={onSelect} onPart={onPart} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(mounted.opts).not.toBeNull())
    mounted.opts?.onSelect({ kind: 'pod', slot: 2 })
    mounted.opts?.onSelect({ kind: 'part', part: 'tank' })
    expect(onSelect).toHaveBeenCalledWith(2)
    expect(onPart).toHaveBeenCalledWith('tank')
  })

  it('gives up without WebGL, or when the renderer fails, and disposes on unmount', async () => {
    const off = vi.fn()
    vi.stubGlobal('WebGLRenderingContext', undefined)
    const a = render(<TowerView pods={pods} waterPct={null} lightLevel={0} onSelect={vi.fn()} onUnavailable={off} />)
    expect(off).toHaveBeenCalled()
    a.unmount()
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
    mounted.fail = true
    const failed = vi.fn()
    render(<TowerView pods={pods} waterPct={null} lightLevel={0} onSelect={vi.fn()} onUnavailable={failed} />)
    await waitFor(() => expect(failed).toHaveBeenCalled())
    mounted.fail = false
    cleanup()
    const b = render(<TowerView pods={pods} waterPct={null} lightLevel={0} onSelect={vi.fn()} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(mounted.opts).not.toBeNull())
    b.unmount()
    expect(mounted.disposed).toBe(1)
  })
})
