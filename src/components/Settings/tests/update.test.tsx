// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateSection } from '../UpdateSection'

type Refetch = (q: { state: { data: unknown } }) => number | false

const { state, calls } = vi.hoisted(() => ({
  state: {
    info: undefined as unknown,
    check: { data: undefined as unknown, error: null as null | { message: string }, isPending: false },
    startError: null as null | { message: string },
    refetch: null as null | Refetch,
  },
  calls: { check: vi.fn(), reset: vi.fn(), setChannel: vi.fn(), start: vi.fn(), invalidate: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ update: { invalidate: calls.invalidate } }),
    update: {
      status: {
        useQuery: (_: unknown, opts: { refetchInterval: Refetch }) => {
          state.refetch = opts.refetchInterval
          return { data: state.info }
        },
      },
      check: { useMutation: () => ({ ...state.check, mutate: () => calls.check(), reset: () => calls.reset() }) },
      setChannel: {
        useMutation: (o: { onSuccess: () => void }) => ({
          isPending: false,
          error: null,
          mutate: (i: unknown) => {
            calls.setChannel(i)
            o.onSuccess()
          },
        }),
      },
      start: {
        useMutation: (o: { onSuccess: () => void }) => ({
          isPending: false,
          error: state.startError,
          mutate: () => {
            calls.start()
            o.onSuccess()
          },
        }),
      },
    },
  },
}))

const idle = { available: true, channel: 'dev', tag: null, status: null, log: [] }
const found = (o: object = {}) => ({
  channel: 'dev',
  installed: { version: 'dev@aaaaaaa', commit: 'aaaaaaa', branch: 'dev', tag: null },
  available: { tag: 'dev-latest', commit: 'bbbbbbbcccc', name: 'Dev (latest)', publishedAt: '2026-11-08T00:00:00Z', url: null },
  updateAvailable: true,
  problem: null,
  ...o,
})
const run = (state: string, o: object = {}) => ({ op: 'update', state, at: '2026-11-08T01:00:00.000Z', to: { tag: 'v1.2.0', commit: 'b'.repeat(40) }, ...o })

beforeEach(() => {
  state.info = idle
  state.check = { data: undefined, error: null, isPending: false }
  state.startError = null
  for (const f of Object.values(calls)) f.mockReset()
})
afterEach(cleanup)

describe('Settings → Updates', () => {
  it('keeps its anchor while loading, and says when the helper isn\'t installed', () => {
    state.info = undefined
    render(<UpdateSection />)
    expect(document.getElementById('update')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    state.info = { ...idle, available: false }
    render(<UpdateSection />)
    expect(screen.getByText(/isn't installed on this core/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows what\'s installed, and only asks GitHub when told to', () => {
    state.info = { ...idle, tag: 'v1.1.0' }
    render(<UpdateSection version="main@aaaaaaa" />)
    expect(screen.getByTestId('update-installed').textContent).toBe('main@aaaaaaa')
    expect(screen.getByText('Release v1.1.0')).toBeTruthy()
    expect(calls.check).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(calls.check).toHaveBeenCalledOnce()
  })

  it('switches channel, and forgets the last check', () => {
    render(<UpdateSection />)
    fireEvent.click(screen.getByRole('tab', { name: 'Stable' }))
    expect(calls.setChannel).toHaveBeenCalledWith({ channel: 'stable' })
    expect(calls.reset).toHaveBeenCalled()
    expect(calls.invalidate).toHaveBeenCalled()
    calls.setChannel.mockReset()
    fireEvent.click(screen.getByRole('tab', { name: 'Dev' }))
    expect(calls.setChannel).not.toHaveBeenCalled()
  })

  it('offers the newer release and asks before updating', () => {
    state.check.data = found()
    render(<UpdateSection />)
    expect(screen.getByTestId('update-available').textContent).toBe('dev-latest (bbbbbbb)')
    fireEvent.click(screen.getByRole('button', { name: 'Update to dev-latest (bbbbbbb)' }))
    expect(calls.start).not.toHaveBeenCalled()
    expect(screen.getByText(/the previous one is put back by itself/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(calls.start).toHaveBeenCalledOnce()
  })

  it('says when it\'s up to date, or why a release can\'t be used', () => {
    state.check.data = found({ updateAvailable: false })
    render(<UpdateSection />)
    expect(screen.getByText('Up to date')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull()
    cleanup()
    state.check.data = found({ problem: 'the release has no hald-arm-unknown-linux-gnueabihf' })
    render(<UpdateSection />)
    expect(screen.getByText('Can\'t update from it: the release has no hald-arm-unknown-linux-gnueabihf')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull()
  })

  it('shows the step and the log while it runs, and polls only then', () => {
    state.info = { ...idle, status: run('downloading'), log: ['2026-11-08T01:00:00Z downloading seedypod-core.tar.gz'] }
    state.check.data = found()
    render(<UpdateSection />)
    expect(screen.getByTestId('update-progress').textContent).toBe('Downloading the release…')
    expect(screen.getByTestId('update-log').textContent).toContain('downloading seedypod-core.tar.gz')
    expect(screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull()
    expect(state.refetch?.({ state: { data: state.info } })).toBe(1500)
    expect(state.refetch?.({ state: { data: { ...idle, status: run('done') } } })).toBe(false)
  })

  it('reports each outcome: done, rolled back, rollback failed, refused', () => {
    state.info = { ...idle, status: run('done'), log: ['done'] }
    render(<UpdateSection />)
    expect(screen.getByTestId('update-result').textContent).toMatch(/^Updated to v1\.2\.0 on /)
    expect(screen.queryByTestId('update-log')).toBeNull()
    cleanup()
    state.info = { ...idle, status: run('rolled-back', { error: 'core did not answer within 300 s', rolledBack: true }), log: ['update failed'] }
    render(<UpdateSection />)
    expect(screen.getByText('The update to v1.2.0 failed, so the previous version was put back: core did not answer within 300 s')).toBeTruthy()
    expect(screen.getByTestId('update-log')).toBeTruthy()
    cleanup()
    state.info = { ...idle, status: run('rollback-failed', { error: 'boom', to: { tag: 'dev-latest', commit: 'c'.repeat(40) } }) }
    render(<UpdateSection />)
    expect(screen.getByText(/The update to dev-latest \(ccccccc\) failed and the previous version didn't come back: boom\. Over SSH, run sudo seedypod-update --rollback\./)).toBeTruthy()
    cleanup()
    state.info = { ...idle, status: run('refused', { error: 'seedypod-core.tar.gz doesn\'t match its checksum', to: undefined }) }
    render(<UpdateSection />)
    expect(screen.getByText('The update didn\'t start, and nothing changed: seedypod-core.tar.gz doesn\'t match its checksum')).toBeTruthy()
  })

  it('offers a reload once the update it started is done', () => {
    state.check.data = found()
    const { rerender } = render(<UpdateSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Update to dev-latest (bbbbbbb)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    state.info = { ...idle, status: run('done') }
    rerender(<UpdateSection />)
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy()
  })

  it('shows a refused start or check', () => {
    state.startError = { message: 'an update is already running' }
    render(<UpdateSection />)
    expect(screen.getByText('an update is already running')).toBeTruthy()
  })
})
