// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buckets, cameraFailure, CamerasPage, failureHint } from '../CamerasPage'

const { data, capture, invalidate } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  capture: { calls: [] as unknown[], fail: new Set<string>() },
  invalidate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, hash, children, ...rest }: { to: string, hash?: string, children: unknown }) => <a href={hash ? `${to}#${hash}` : to} {...rest}>{children as string}</a> }))

vi.mock('@/src/utils/trpc', async () => {
  const { useState } = await import('react')
  return {
    apiBase: () => '',
    trpc: {
      useUtils: () => ({ camera: { invalidate }, alerts: { invalidate } }),
      camera: {
        list: { useQuery: (input: { camera: string }) => ({ data: data.get(`frames-${input.camera}`) }) },
        capture: { useMutation: (o?: { onSettled?: () => void }) => {
          const [error, setError] = useState<Error | null>(null)
          const run = (input: { camera: string }) => {
            capture.calls.push(input)
            const e = capture.fail.has(input.camera) ? new Error(`${input.camera} camera returned no usable image`) : null
            setError(e)
            o?.onSettled?.()
            return e
          }
          return {
            isPending: false,
            isError: !!error,
            error,
            submittedAt: Date.parse('2026-11-01T11:00:00Z'),
            mutate: (input: { camera: string }) => void run(input),
            mutateAsync: async (input: { camera: string }) => {
              const e = run(input)
              if (e) throw e
            },
          }
        } },
      },
      settings: { get: { useQuery: () => ({ data: data.get('settings') }) } },
      alerts: { list: { useQuery: () => ({ data: data.get('alerts') }) } },
    },
  }
})

const frame = (camera: 'upper' | 'lower', ts: string) => ({ id: `${camera}-${ts}`, camera, ts, path: `${camera}.jpg`, bytes: 40_000, url: `/api/captures/${camera}-${ts}.jpg` })
const alert = (detail: string, raisedAt = '2026-11-01T08:00:00Z', active = true) => ({ id: 1, kind: 'camera_missing', active, detail, raisedAt, clearedAt: null, acknowledgedAt: null, dismissedAt: null })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  data.clear()
  capture.calls = []
  capture.fail.clear()
  invalidate.mockReset()
  // Newest first, as the API returns them.
  data.set('frames-upper', [frame('upper', '2026-11-01T10:00:00Z'), frame('upper', '2026-11-01T09:00:00Z'), frame('upper', '2026-10-28T09:00:00Z')])
  data.set('frames-lower', [frame('lower', '2026-11-01T07:00:00Z')])
  data.set('settings', { captureIntervalMin: 60 })
  data.set('alerts', [alert('lower camera returned 4 bytes')])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CamerasPage', () => {
  it('sums the last two days of frames under the timelapse interval', () => {
    render(<CamerasPage />)
    expect(screen.getByText('Timelapse every 60 min · 3 frames in the last 2 days')).toBeTruthy()
    cleanup()
    data.set('settings', { captureIntervalMin: 0 })
    data.set('frames-lower', [])
    render(<CamerasPage />)
    expect(screen.getByText('Timelapse off · 2 frames in the last 2 days')).toBeTruthy()
  })

  it('shows the latest frame and scrubs back through older ones', () => {
    render(<CamerasPage />)
    const upper = within(screen.getByTestId('camera-upper'))
    expect(upper.getByAltText('upper camera at 2026-11-01T10:00:00Z')).toBeTruthy()
    expect(upper.getByText(/2 h ago/)).toBeTruthy()
    expect(upper.getByText('drag to scrub')).toBeTruthy()
    fireEvent.change(upper.getByLabelText('Upper timelapse position'), { target: { value: '0' } })
    expect(upper.getByAltText('upper camera at 2026-10-28T09:00:00Z')).toBeTruthy()
    expect(upper.queryByTestId('failed-capture')).toBeNull()
  })

  it('replaces a failing camera\'s frame with why, and retries it', () => {
    render(<CamerasPage />)
    const lower = within(screen.getByTestId('camera-lower'))
    expect(lower.getByText(/No frame since/)).toBeTruthy()
    expect(lower.getByText('Last capture returned 4 bytes. Check the ribbon cable, then capture again.')).toBeTruthy()
    expect(lower.getByText('capture failed · 4 h ago')).toBeTruthy()
    expect(lower.getByText('latest capture failed')).toBeTruthy()
    expect(lower.getByTestId('failed-capture')).toBeTruthy()
    expect(lower.queryByRole('img')).toBeNull()
    fireEvent.click(lower.getByText('Retry'))
    expect(capture.calls).toEqual([{ camera: 'lower' }])
    expect(invalidate).toHaveBeenCalled()
  })

  it('captures both cameras in turn, carrying on past a failure', async () => {
    capture.fail.add('upper')
    data.set('alerts', [])
    render(<CamerasPage />)
    fireEvent.click(screen.getByText('Capture both'))
    await vi.waitFor(() => expect(capture.calls).toEqual([{ camera: 'upper' }, { camera: 'lower' }]))
    const upper = within(screen.getByTestId('camera-upper'))
    expect(upper.getByText('Last capture failed: upper camera returned no usable image. Check the ribbon cable, then capture again.')).toBeTruthy()
    expect(upper.getByText('Retry')).toBeTruthy()
  })

  it('plays a camera\'s timelapse at the chosen speed', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(2000), { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetch)
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:test/${n++}`)
    URL.revokeObjectURL = vi.fn()
    try {
      render(<CamerasPage />)
      const upper = within(screen.getByTestId('camera-upper'))
      expect(upper.getByText('3 / 3')).toBeTruthy()
      fireEvent.click(upper.getByLabelText('Upper playback speed'))
      expect(upper.getByText('10 fps')).toBeTruthy()
      fireEvent.click(upper.getByLabelText('Play upper timelapse'))
      expect(upper.getByText('Pause')).toBeTruthy()
      await waitFor(() => expect(upper.getByText('1 / 3')).toBeTruthy())
      expect((upper.getByAltText('upper camera at 2026-10-28T09:00:00Z') as HTMLImageElement).src).toMatch(/^blob:test\//)
      await waitFor(() => expect(upper.getByText('3 / 3')).toBeTruthy())
      await waitFor(() => expect(upper.getByLabelText('Play upper timelapse')).toBeTruthy())
      expect(fetch).toHaveBeenCalledTimes(3)
      // One frame is nothing to play.
      expect(within(screen.getByTestId('camera-lower')).queryByLabelText('Play lower timelapse')).toBeNull()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('enlarges the frame and links to Analysis and the capture settings', () => {
    data.set('frames-lower', [])
    render(<CamerasPage />)
    expect(screen.getByText('Open Analysis →').getAttribute('href')).toBe('/analysis')
    expect(screen.getByText('Capture settings →').getAttribute('href')).toBe('/settings#cameras')
    expect(within(screen.getByTestId('camera-lower')).getAllByText('No frames yet').length).toBeGreaterThan(0)
    fireEvent.click(within(screen.getByTestId('camera-upper')).getByLabelText('Enlarge'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('cameraFailure', () => {
  const latest = frame('lower', '2026-11-01T07:00:00Z')
  it('takes the alert that names this camera', () => {
    expect(cameraFailure('lower', latest, [alert('lower camera returned 4 bytes')], null)).toEqual({ ts: '2026-11-01T08:00:00Z', message: 'lower camera returned 4 bytes' })
    expect(cameraFailure('upper', latest, [alert('lower camera returned 4 bytes')], null)).toBeNull()
    expect(cameraFailure('lower', latest, [alert('lower camera returned 4 bytes', '2026-11-01T08:00:00Z', false)], null)).toBeNull()
    // Both cameras failing share the one alert, and hald's wording has a colon.
    expect(cameraFailure('lower', latest, [alert('upper camera: torn; lower camera: gone')], null)?.message).toBe('upper camera: torn; lower camera: gone')
  })
  it('clears once a newer frame lands', () => {
    expect(cameraFailure('lower', frame('lower', '2026-11-01T09:00:00Z'), [alert('lower camera returned 4 bytes')], null)).toBeNull()
  })
  it('uses this session\'s failure, keeping the alert\'s wording when there is one', () => {
    const local = { ts: '2026-11-01T11:00:00Z', message: 'lower camera returned no usable image' }
    expect(cameraFailure('lower', latest, [], local)).toEqual(local)
    expect(cameraFailure('lower', latest, [alert('lower camera returned 4 bytes')], local)).toEqual({ ts: local.ts, message: 'lower camera returned 4 bytes' })
    expect(cameraFailure('lower', undefined, [], local)).toEqual(local)
  })
})

describe('failureHint', () => {
  it('names the byte count when the camera sent a stub', () => {
    expect(failureHint('lower camera returned 4 bytes')).toBe('Last capture returned 4 bytes. Check the ribbon cable, then capture again.')
    expect(failureHint('hald timed out')).toBe('Last capture failed: hald timed out. Check the ribbon cable, then capture again.')
  })
})

describe('buckets', () => {
  it('keeps one bar per frame up to the cap, then groups', () => {
    expect(buckets(3)).toEqual([[0, 0], [1, 1], [2, 2]])
    expect(buckets(0)).toEqual([])
    const grouped = buckets(200, 48)
    expect(grouped).toHaveLength(48)
    expect(grouped[0]?.[0]).toBe(0)
    expect(grouped.at(-1)?.[1]).toBe(199)
  })
})
