// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TowerMountOptions } from '../towerRenderer'
import type { TowerState } from '../towerScene'
import { PodCallout, TowerView } from '../TowerView'

const { mounted } = vi.hoisted(() => ({ mounted: { opts: null as TowerMountOptions | null, updates: [] as TowerState[], disposed: 0, fail: false, at: null as { x: number, y: number } | null } }))

vi.mock('../towerRenderer', () => ({
  mountTower: (_host: HTMLElement, opts: TowerMountOptions) => {
    if (mounted.fail) throw new Error('no context')
    mounted.opts = opts
    queueMicrotask(opts.onReady)
    return { update: (s: TowerState) => mounted.updates.push(s), anchor: () => mounted.at, dispose: () => mounted.disposed++ }
  },
}))

const pods = [{ slot: 1, status: 'growing' as const, plant: 'Basil', green: 0.42 }, { slot: 2, status: 'empty' as const, plant: null }]

beforeEach(() => {
  Object.assign(mounted, { opts: null, updates: [], disposed: 0, fail: false, at: null })
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

  it('previews the hovered pod\'s callout in place of the picked one\'s, and names a part only where it has a control', async () => {
    const onPart = vi.fn()
    const { rerender } = render(<TowerView pods={pods} waterPct={null} lightLevel={0} selected={2} onSelect={vi.fn()} podAction={<a href="/grow">Edit on Grow</a>} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Loading the tower…')).toBeNull())
    mounted.at = { x: 200, y: 300 }
    act(() => mounted.opts?.onRender?.())
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Pod 2')
    act(() => mounted.opts?.onHover({ kind: 'pod', slot: 1 }))
    act(() => mounted.opts?.onRender?.())
    expect(mounted.updates.at(-1)?.hovered).toBe(1)
    // One callout at a time, without the picked pod's link; no separate hover card.
    expect(screen.getAllByRole('group').map(g => g.getAttribute('aria-label'))).toEqual(['Pod 1'])
    expect(screen.queryByText('Edit on Grow')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    act(() => mounted.opts?.onHover(null))
    expect(screen.getByRole('group', { name: 'Pod 2' }).textContent).toContain('Edit on Grow')
    act(() => mounted.opts?.onHover({ kind: 'part', part: 'light' }))
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<TowerView pods={pods} waterPct={null} lightLevel={0} onSelect={vi.fn()} onPart={onPart} partLabels={{ light: 'Grow light · off' }} onUnavailable={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Grow light · offClick to adjust')
  })

  it('pins a callout to the picked pod, follows it each frame, and puts the status chips top right', async () => {
    const trended = [{ ...pods[0], ageDays: 18.7, verdict: 'growing' as const, recent: [0.3, 0.36, 0.42], notes: 'pinch tops' }, pods[1]]
    const { rerender } = render(<TowerView pods={trended} waterPct={null} lightLevel={0} selected={1} onSelect={vi.fn()} onUnavailable={vi.fn()} status={<button type="button">Day 19</button>} podAction={<a href="/grow?pod=1">Edit on Grow</a>} />)
    await waitFor(() => expect(screen.queryByText('Loading the tower…')).toBeNull())
    expect(screen.getByRole('button', { name: 'Day 19' })).toBeTruthy()
    expect(screen.queryByTestId('pod-callout')).toBeNull()
    mounted.at = { x: 120.4, y: 300 }
    act(() => mounted.opts?.onRender?.())
    const callout = screen.getByRole('group', { name: 'Pod 1' })
    expect(callout.textContent).toBe('Pod 1BasilGrowingAge18 dGreen42%Trend↑ Gainingpinch topsEdit on Grow')
    expect(callout.querySelector('polyline')?.getAttribute('points')).toMatch(/^2,16 /)
    expect(callout.previousElementSibling?.querySelector('circle')?.getAttribute('cx')).toBe('120')
    // The picked pod's hover adds nothing over its callout.
    act(() => mounted.opts?.onHover({ kind: 'pod', slot: 1 }))
    expect(screen.queryByRole('status')).toBeNull()
    mounted.at = null
    act(() => mounted.opts?.onRender?.())
    expect(screen.queryByTestId('pod-callout')).toBeNull()
    act(() => mounted.opts?.onHover(null))
    mounted.at = { x: 50, y: 60 }
    rerender(<TowerView pods={trended} waterPct={null} lightLevel={0} selected={null} onSelect={vi.fn()} onUnavailable={vi.fn()} />)
    act(() => mounted.opts?.onRender?.())
    expect(screen.queryByTestId('pod-callout')).toBeNull()
  })

  it('flags pods to harvest or see to before they are picked, and picks one from its flag', async () => {
    const onSelect = vi.fn()
    const flagged = [{ slot: 1, status: 'harvest' as const, plant: 'Chard' }, { slot: 2, status: 'attention' as const, plant: 'Kale' }, { slot: 3, status: 'growing' as const, plant: 'Basil' }]
    const { rerender } = render(<TowerView pods={flagged} waterPct={null} lightLevel={0} onSelect={onSelect} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Loading the tower…')).toBeNull())
    mounted.at = { x: 200, y: 300 }
    act(() => mounted.opts?.onRender?.())
    const harvest = screen.getByRole('button', { name: 'Pod 1: Ready to harvest' })
    expect(harvest.style.left).toBe('216px')
    expect(screen.getByRole('button', { name: 'Pod 2: Needs attention' }).querySelector('.motion-safe\\:animate-ping')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Pod 3/ })).toBeNull()
    act(() => harvest.click())
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(harvest.getAttribute('aria-pressed')).toBe('false')
    // Picked, the flag stays, ringed, and the callout leads from it rather than the collar.
    rerender(<TowerView pods={flagged} waterPct={null} lightLevel={0} selected={2} onSelect={onSelect} onUnavailable={vi.fn()} />)
    act(() => mounted.opts?.onRender?.())
    const attention = screen.getByRole('button', { name: 'Pod 2: Needs attention' })
    expect(attention.getAttribute('aria-pressed')).toBe('true')
    expect(attention.className).toContain('outline')
    expect(attention.querySelector('.motion-safe\\:animate-ping')).toBeNull()
    const callout = screen.getByRole('group', { name: 'Pod 2' })
    expect(callout.textContent).toContain('Needs attention')
    expect(callout.previousElementSibling?.querySelector('polyline')?.getAttribute('points')).toMatch(/^216,284 /)
    expect(callout.previousElementSibling?.querySelector('circle')).toBeNull()
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

describe('PodCallout', () => {
  const box = () => screen.getByTestId('pod-callout').style

  it('reads out outward from the tower, above the pod, and flips when that side has no room', () => {
    const pod = { slot: 4, status: 'attention' as const, plant: 'Kale', green: 0.2, verdict: 'declining' as const, recent: [0.3, 0.25, 0.2] }
    const { rerender } = render(<PodCallout pod={pod} at={{ x: 600, y: 400 }} width={1000} height={800} />)
    // Right of centre: the line runs from the flag up and right, and the readout starts where it ends.
    expect(document.querySelector('polyline')?.getAttribute('points')).toBe('616,384 652,336 740,336')
    expect([box().left, box().top]).toEqual(['740px', '296px'])
    expect(screen.getByTestId('pod-callout').textContent).toBe('Pod 4KaleNeeds attentionGreen20%Trend↓ Shrinking')
    expect(screen.getByText('Needs attention').className).toContain('border')
    // No room on the right: it reads out to the left, anchored by its right edge.
    rerender(<PodCallout pod={pod} at={{ x: 900, y: 400 }} width={1000} height={800} />)
    expect(document.querySelector('polyline')?.getAttribute('points')).toBe('916,384 880,336 792,336')
    expect([box().right, box().left]).toEqual(['208px', ''])
    // Near the top, the line runs down so the readout clears the chips.
    rerender(<PodCallout pod={pod} at={{ x: 300, y: 80 }} width={1000} height={800} />)
    expect(document.querySelector('polyline')?.getAttribute('points')).toBe('316,64 352,112 440,112')
  })

  it('leaves out what it does not know: an empty pod, a pod without a trend', () => {
    const { rerender } = render(<PodCallout pod={{ slot: 9, status: 'empty', plant: null, verdict: 'unknown' }} at={{ x: 100, y: 400 }} width={1000} height={800} />)
    expect(screen.getByTestId('pod-callout').textContent).toBe('Pod 9Empty')
    rerender(<PodCallout pod={{ slot: 9, status: 'seeded', plant: 'Mint', ageDays: 2.9, verdict: 'stalled', recent: [0.1, 0.1] }} at={{ x: 100, y: 400 }} width={1000} height={800} />)
    expect(screen.getByTestId('pod-callout').textContent).toBe('Pod 9MintSeededAge2 dTrend→ Flat')
    expect(screen.getByText('Seeded').className).not.toContain('border')
    expect(screen.getByTestId('pod-callout').querySelector('svg')).toBeNull()
  })
})
