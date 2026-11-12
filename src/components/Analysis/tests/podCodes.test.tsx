// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeGlyphs, PodCodes } from '../PodCodes'

const { state, calls, invalidate } = vi.hoisted(() => ({
  state: { data: undefined as unknown, read: { isPending: false, isSuccess: false, data: undefined as unknown, error: null as null | { message: string } } },
  calls: { read: vi.fn(), confirm: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ vision: { podCodes: { invalidate } } }),
    vision: {
      podCodes: { useQuery: () => ({ data: state.data }) },
      readPodCodes: { useMutation: (o: { onSuccess: () => void }) => ({ ...state.read, mutate: () => {
        calls.read()
        o.onSuccess()
      } }) },
      confirmPodCode: { useMutation: (o: { onSuccess: () => void }) => ({ isPending: false, error: null, mutate: (v: unknown) => {
        calls.confirm(v)
        o.onSuccess()
      } }) },
    },
  },
}))

const pod = (slot: number, code: string, confirmed: string | null, recorded: string | null) => ({ slot, camera: 'upper', code, confidence: 0.9, ts: '2026-11-11T21:00:00.000Z', confirmed, recorded })

beforeEach(() => {
  state.data = undefined
  state.read = { isPending: false, isSuccess: false, data: undefined, error: null }
  calls.read.mockClear()
  calls.confirm.mockClear()
  invalidate.mockClear()
})
afterEach(cleanup)

describe('PodCodes (#224)', () => {
  it('draws a code as its dots, with words for screen readers', () => {
    render(<CodeGlyphs code="o|/h" />)
    const g = screen.getByLabelText('open, bar, slanted bar, half, solid')
    expect(g.textContent).toBe('○⦶⊘◐●')
  })

  it('shows nothing before it has loaded, or where codes can\'t be read and none were', () => {
    const { container, rerender } = render(<PodCodes />)
    expect(container.innerHTML).toBe('')
    state.data = { available: false, pods: [], pairs: [] }
    rerender(<PodCodes />)
    expect(container.innerHTML).toBe('')
  })

  it('lists only read pods: the record\'s plant as a guess to confirm, a confirmed one with a tick', () => {
    state.data = {
      available: true,
      pods: [pod(1, 'ooh|', 'Chives', 'Basil'), pod(6, 'oo||', null, 'Green Bok Choy'), pod(8, 'o||o', null, null)],
      pairs: [{ code: 'ooh|', plant: 'Chives', confirmedAt: 't' }],
    }
    render(<PodCodes />)
    const six = screen.getByTestId('pod-code-6')
    expect(six.textContent).toContain('Pod 6reads as○○⦶⦶●·Green Bok Choy?')
    fireEvent.click(within(six).getByRole('button', { name: 'Confirm' }))
    expect(calls.confirm).toHaveBeenCalledWith({ code: 'oo||', plant: 'Green Bok Choy' })
    expect(invalidate).toHaveBeenCalled()

    const one = screen.getByTestId('pod-code-1')
    expect(within(one).getByLabelText('confirmed')).toBeTruthy()
    expect(within(one).queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(one.textContent).toContain('Chives')
    expect(one.textContent).not.toContain('Basil')

    // No plant on record: say which.
    const eight = screen.getByTestId('pod-code-8')
    expect(eight.textContent).toContain('which plant?')
    expect(within(eight).queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.queryByTestId('pod-code-9')).toBeNull()
  })

  it('corrects a code to another plant, offering the plants it knows', () => {
    state.data = { available: true, pods: [pod(6, 'oo||', null, 'Basil')], pairs: [{ code: 'ooh|', plant: 'Chives', confirmedAt: 't' }] }
    render(<PodCodes />)
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }))
    const field = screen.getByLabelText('Pod 6\'s plant') as HTMLInputElement
    expect(field.value).toBe('Basil')
    const options = [...document.querySelectorAll('#pod-code-plants-6 option')].map(o => (o as HTMLOptionElement).value)
    expect(options).toEqual(['Basil', 'Chives'])
    fireEvent.change(field, { target: { value: '  ' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: ' Green Bok Choy ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.confirm).toHaveBeenCalledWith({ code: 'oo||', plant: 'Green Bok Choy' })
    expect(screen.queryByLabelText('Pod 6\'s plant')).toBeNull()
  })

  it('reads on demand and says what went wrong per camera', () => {
    state.data = { available: true, pods: [], pairs: [] }
    state.read = { isPending: false, isSuccess: true, data: [{ camera: 'upper', ts: 't', read: 0, error: null }, { camera: 'lower', ts: null, read: 0, error: 'the lower pod-ID still was too dark to read' }], error: null }
    render(<PodCodes />)
    fireEvent.click(screen.getByRole('button', { name: 'Read codes' }))
    expect(calls.read).toHaveBeenCalled()
    expect(screen.getByText('No code could be read. Small or steeply angled pods, and a dark tower, read as nothing.')).toBeTruthy()
    expect(screen.getByText('Lower: the lower pod-ID still was too dark to read')).toBeTruthy()
  })

  it('shows reads it already has without podvision, but no Read button', () => {
    state.data = { available: false, pods: [pod(6, 'oo||', 'Green Bok Choy', 'Green Bok Choy')], pairs: [] }
    render(<PodCodes />)
    expect(screen.queryByRole('button', { name: 'Read codes' })).toBeNull()
    expect(screen.getByTestId('pod-code-6')).toBeTruthy()
    expect(screen.getByText(/read 2026|read \w{3} \d/)).toBeTruthy()
  })

  it('says while it reads, and shows a failed read', () => {
    state.data = { available: true, pods: [], pairs: [] }
    state.read = { isPending: true, isSuccess: false, data: undefined, error: { message: 'podvision isn\'t installed' } }
    render(<PodCodes />)
    expect((screen.getByRole('button', { name: 'Reading…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('podvision isn\'t installed')).toBeTruthy()
  })
})
