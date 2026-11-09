// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { podRegions } from '@/src/vision/regions'
import { HISTORY, LabelPods } from '../LabelPods'

const { data, calls, invalidate, mutation } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { frames: vi.fn(), labels: vi.fn(), setLabel: vi.fn() },
  invalidate: vi.fn(),
  mutation: { fail: false, error: null as null | { message: string } },
}))

vi.mock('@/src/utils/trpc', () => ({
  apiBase: () => 'http://unit',
  trpc: {
    useUtils: () => ({ vision: { invalidate } }),
    camera: { list: { useQuery: (input: { camera: string }) => {
      calls.frames(input)
      return { data: data.get(`frames:${input.camera}`) }
    } } },
    vision: {
      labels: { useQuery: (input: { captureId: string }, opts?: { enabled?: boolean }) => {
        calls.labels(input, opts)
        return { data: opts?.enabled === false ? undefined : data.get(`labels:${input.captureId}`) }
      } },
      labelStats: { useQuery: () => ({ data: data.get('stats') }) },
      setLabel: { useMutation: (o: { onSuccess?: () => void, onError?: (e: Error, v: unknown) => void }) => ({
        error: mutation.error,
        mutate: (v: unknown) => {
          calls.setLabel(v)
          if (mutation.fail) o.onError?.(new Error('nope'), v)
          else o.onSuccess?.()
        },
      }) },
    },
  },
}))

const frame = (camera: string, i: number) => ({ id: `${camera}-${i}`, camera, ts: `2026-11-0${9 - i}T10:00:00Z`, path: `${camera}-${i}.jpg`, bytes: 1, url: `/api/captures/${camera}-${i}.jpg` })
const label = (captureId: string, slot: number, l: string) => ({ captureId, ts: '', camera: 'upper', slot, label: l, labelledAt: '' })
const pod = (slot: number) => screen.getByRole('button', { name: new RegExp(`^Pod ${slot}:`) })
const boxes = (c: 'upper' | 'lower') => podRegions(c)

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  invalidate.mockReset()
  mutation.fail = false
  mutation.error = null
})
afterEach(cleanup)

describe('LabelPods', () => {
  it('shows each label\'s count and the newest upper still with its labels', () => {
    data.set('frames:upper', [frame('upper', 0), frame('upper', 1)])
    data.set('labels:upper-0', [label('upper-0', 2, 'sprouted')])
    data.set('stats', { counts: { empty: 4, sprouted: 1, growing: 0, ready: 2, unhealthy: 1 }, pods: 8, captures: [] })
    render(<LabelPods boxes={boxes} />)
    expect(calls.frames).toHaveBeenLastCalledWith({ camera: 'upper', limit: HISTORY })
    expect(screen.getByTestId('count-empty').textContent).toBe('Empty 4')
    expect(screen.getByTestId('count-unhealthy').textContent).toBe('Unhealthy 1')
    expect(screen.getByText('8 pods labelled')).toBeTruthy()
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('http://unit/api/captures/upper-0.jpg')
    expect(screen.getByTestId('label-pods').querySelectorAll('button')).toHaveLength(15)
    expect(pod(2).getAttribute('aria-label')).toBe('Pod 2: sprouted')
    expect(pod(2).textContent).toBe('2 · sprouted')
    expect(pod(1).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(/1 of 15 pods labelled/)).toBeTruthy()
  })

  it('tags a pod with one tap, retags it with another label, and clears it with a second tap', () => {
    data.set('frames:upper', [frame('upper', 0)])
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(pod(4))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 4, label: 'growing' })
    expect(pod(4).getAttribute('aria-label')).toBe('Pod 4: growing')
    expect(invalidate).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Growing' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
    expect(screen.getByRole('button', { name: 'Ready' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(pod(4))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 4, label: 'ready' })
    fireEvent.click(pod(4))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-0', slot: 4, label: null })
    expect(pod(4).getAttribute('aria-label')).toBe('Pod 4: not labelled')
  })

  it('puts a tag back when the unit refuses it, and says why', () => {
    data.set('frames:upper', [frame('upper', 0)])
    data.set('labels:upper-0', [label('upper-0', 5, 'empty')])
    mutation.fail = true
    mutation.error = { message: 'no capture upper-0' }
    render(<LabelPods boxes={boxes} />)
    fireEvent.click(screen.getByRole('button', { name: 'Unhealthy' }))
    fireEvent.click(pod(5))
    expect(pod(5).getAttribute('aria-label')).toBe('Pod 5: empty')
    expect(screen.getByText('no capture upper-0')).toBeTruthy()
  })

  it('steps to older and newer photos, and switches camera', () => {
    data.set('frames:upper', [frame('upper', 0), frame('upper', 1)])
    data.set('frames:lower', [frame('lower', 0)])
    render(<LabelPods boxes={boxes} />)
    const newer = screen.getByRole('button', { name: 'Newer photo' }) as HTMLButtonElement
    const older = screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement
    expect(newer.disabled).toBe(true)
    fireEvent.click(older)
    expect(calls.labels).toHaveBeenLastCalledWith({ captureId: 'upper-1' }, { enabled: true })
    expect(older.disabled).toBe(true)
    fireEvent.click(pod(1))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'upper-1', slot: 1, label: 'growing' })
    fireEvent.click(newer)
    expect(calls.labels).toHaveBeenLastCalledWith({ captureId: 'upper-0' }, { enabled: true })
    // A tag on one photo doesn't show on the next.
    expect(pod(1).getAttribute('aria-label')).toBe('Pod 1: not labelled')

    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))
    expect(calls.frames).toHaveBeenLastCalledWith({ camera: 'lower', limit: HISTORY })
    expect(screen.getByRole('button', { name: /^Pod 16:/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Pod 30:/ }))
    expect(calls.setLabel).toHaveBeenLastCalledWith({ captureId: 'lower-0', slot: 30, label: 'growing' })
  })

  it('says when a camera has no photos, and takes a demo still as it is', () => {
    data.set('frames:lower', [{ ...frame('lower', 0), path: 'data:image/svg+xml;utf8,<svg/>' }])
    render(<LabelPods boxes={boxes} />)
    expect(screen.getByText('No photos from this camera yet.')).toBeTruthy()
    expect(screen.getByText('0 pods labelled')).toBeTruthy()
    expect(calls.labels).toHaveBeenLastCalledWith({ captureId: '' }, { enabled: false })
    expect((screen.getByRole('button', { name: 'Older photo' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }))
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.src).toMatch(/^data:image\/svg/)
    Object.defineProperty(img, 'naturalWidth', { value: 1280 })
    Object.defineProperty(img, 'naturalHeight', { value: 720 })
    fireEvent.load(img)
    expect((img.parentElement as HTMLElement).style.aspectRatio).toMatch(/^1\.77/)
  })
})
