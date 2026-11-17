// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeGlyphs, codesWaiting, PodCodes } from '../PodCodes'

const { state, calls, invalidate } = vi.hoisted(() => ({
  state: { data: undefined as unknown, share: undefined as unknown, read: { isPending: false, isSuccess: false, data: undefined as unknown, error: null as null | { message: string } } },
  calls: { read: vi.fn(), confirm: vi.fn() },
  invalidate: vi.fn(),
}))

vi.mock('@/src/utils/trpc', () => ({
  apiBase: () => 'http://unit',
  trpc: {
    useUtils: () => ({ vision: { podCodes: { invalidate } } }),
    vision: {
      podCodes: { useQuery: () => ({ data: state.data }) },
      podCodeShare: { useQuery: () => ({ data: state.share }) },
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

const pod = (slot: number, code: string, confirmed: string | null, recorded: string | null, shared: string | null = null) => {
  const guess = confirmed ?? shared ?? recorded
  const from = confirmed ? 'own' : shared ? 'shared' : recorded ? 'record' : null
  return { slot, camera: 'upper', code, confidence: 0.9, ts: '2026-11-11T21:00:00.000Z', confirmed, recorded, shared, guess, from, disagrees: !!confirmed && !!shared && confirmed !== shared }
}

beforeEach(() => {
  state.data = undefined
  state.share = undefined
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

  it('lists only read pods compactly: the record\'s plant as a guess to ✓, a confirmed one with a tick, and fix on each', () => {
    state.data = {
      available: true,
      pods: [pod(1, 'ooh|', 'Chives', 'Basil'), pod(6, 'oo||', null, 'Green Bok Choy'), pod(8, 'o||o', null, null)],
      pairs: [{ code: 'ooh|', plant: 'Chives', confirmedAt: 't' }],
    }
    render(<PodCodes />)
    // Two of the three still wait on the grower.
    expect(screen.getByText(/^2 to confirm · read /)).toBeTruthy()
    const six = screen.getByTestId('pod-code-6')
    expect(six.textContent).toBe('Pod 6○○⦶⦶●Green Bok Choy?fix')
    fireEvent.click(within(six).getByRole('button', { name: 'Confirm pod 6 as Green Bok Choy' }))
    expect(calls.confirm).toHaveBeenCalledWith({ code: 'oo||', plant: 'Green Bok Choy' })
    expect(invalidate).toHaveBeenCalled()
    // Fix opens the editor in the row.
    const fix = within(six).getByRole('button', { name: 'Correct pod 6' })
    expect(fix.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(fix)
    expect(fix.getAttribute('aria-expanded')).toBe('true')
    expect((screen.getByLabelText('Pod 6\'s plant') as HTMLInputElement).value).toBe('Green Bok Choy')

    const one = screen.getByTestId('pod-code-1')
    expect(within(one).getByLabelText('confirmed')).toBeTruthy()
    expect(within(one).queryByRole('button', { name: /^Confirm/ })).toBeNull()
    expect(within(one).getByRole('button', { name: 'Correct pod 1' })).toBeTruthy()
    expect(one.textContent).toContain('Chives')
    expect(one.textContent).not.toContain('Basil')

    // No plant on record: say which.
    const eight = screen.getByTestId('pod-code-8')
    expect(eight.textContent).toContain('which plant?')
    expect(within(eight).queryByRole('button', { name: /^Confirm/ })).toBeNull()
    expect(within(eight).getByRole('button', { name: 'Say which plant is in pod 8' }).textContent).toBe('say which')
    expect(screen.queryByTestId('pod-code-9')).toBeNull()
  })

  it('counts only the codes waiting on the grower', () => {
    expect(codesWaiting([{ confirmed: null }, { confirmed: 'Kale' }, { confirmed: null }])).toBe(2)
    expect(codesWaiting([])).toBe(0)
    state.data = { available: false, pods: [pod(6, 'oo||', 'Kale', 'Kale')], pairs: [] }
    render(<PodCodes />)
    expect(screen.queryByText(/to confirm/)).toBeNull()
  })

  it('shows a shared match as a known code, which still needs a tap and saves the owner\'s own pair (#259)', () => {
    state.data = { available: true, pods: [pod(6, 'oo||', null, 'Cilantro', 'Green Bok Choy')], pairs: [] }
    render(<PodCodes />)
    const six = screen.getByTestId('pod-code-6')
    expect(six.textContent).toContain('Green Bok Choy · known code')
    expect(six.textContent).not.toContain('Cilantro')
    expect(calls.confirm).not.toHaveBeenCalled()
    fireEvent.click(within(six).getByRole('button', { name: 'Confirm pod 6 as Green Bok Choy' }))
    expect(calls.confirm).toHaveBeenCalledWith({ code: 'oo||', plant: 'Green Bok Choy' })
    // Correcting starts from the known code, and offers both plants.
    fireEvent.click(within(six).getByRole('button', { name: 'Correct pod 6' }))
    expect((screen.getByLabelText('Pod 6\'s plant') as HTMLInputElement).value).toBe('Green Bok Choy')
    expect([...document.querySelectorAll('#pod-code-plants-6 option')].map(o => (o as HTMLOptionElement).value)).toEqual(['Cilantro', 'Green Bok Choy'])
  })

  it('keeps the owner\'s pair where the shared table disagrees, and says so (#259)', () => {
    state.data = { available: true, pods: [pod(6, 'oo||', 'Cilantro', 'Cilantro', 'Green Bok Choy'), pod(1, 'ooh|', 'Chives', null, 'Chives')], pairs: [] }
    render(<PodCodes />)
    const six = screen.getByTestId('pod-code-6')
    expect(within(six).getByLabelText('confirmed')).toBeTruthy()
    expect(six.textContent).toContain('Other units say this code is Green Bok Choy. Yours is kept.')
    expect(screen.getByTestId('pod-code-1').textContent).not.toContain('Other units')
  })

  it('offers Share pod codes only once there are confirmed pairs (#259)', () => {
    state.data = { available: true, pods: [pod(6, 'oo||', null, 'Basil')], pairs: [] }
    const { rerender } = render(<PodCodes />)
    expect(screen.queryByRole('button', { name: 'Share pod codes' })).toBeNull()
    state.data = { available: true, pods: [pod(6, 'oo||', 'Green Bok Choy', 'Basil')], pairs: [{ code: 'oo||', plant: 'Green Bok Choy', confirmedAt: 't' }] }
    rerender(<PodCodes />)
    const share = screen.getByRole('button', { name: 'Share pod codes' })
    expect(share.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(share)
    // Still loading: nothing yet.
    expect(screen.queryByTestId('share-pod-codes')).toBeNull()
    state.share = { url: 'https://github.com/seedypod/core/issues/new?template=pod-codes.yml', pairs: [{ code: 'oo||', plant: 'Green Bok Choy' }], skipped: [{ code: 'o|hh', plant: 'Genovese Basil' }], crops: [{ slot: 6, code: 'oo||', plant: 'Green Bok Choy' }] }
    rerender(<PodCodes />)
    const panel = screen.getByTestId('share-pod-codes')
    expect(panel.textContent).toContain('your 1 confirmed code, this app\'s version and a one-way hash of the unit\'s id')
    expect(panel.textContent).toContain('nothing is sent from the unit')
    // The browser opens the form: a plain link in a new tab.
    const form = within(panel).getByRole('link', { name: 'Open the form' })
    expect(form.getAttribute('href')).toBe('https://github.com/seedypod/core/issues/new?template=pod-codes.yml')
    expect(form.getAttribute('target')).toBe('_blank')
    expect(form.getAttribute('rel')).toBe('noopener noreferrer')
    expect(panel.textContent).toContain('Left out, not in the plant catalog: Genovese Basil.')
    const crop = within(panel).getByRole('link', { name: 'Pod 6 · Green Bok Choy' })
    expect(crop.getAttribute('href')).toBe('http://unit/api/vision/pod-codes/crops/pod-6.jpg')
    expect(crop.getAttribute('download')).toBe('pod-6.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Share pod codes' }))
    expect(screen.queryByTestId('share-pod-codes')).toBeNull()
  })

  it('says there is nothing to share when no confirmed plant is in the catalog (#259)', () => {
    state.data = { available: true, pods: [], pairs: [{ code: 'o|hh', plant: 'Genovese Basil', confirmedAt: 't' }, { code: 'oo||', plant: 'Kale Sprouts', confirmedAt: 't' }] }
    state.share = { url: null, pairs: [], skipped: [{ code: 'o|hh', plant: 'Genovese Basil' }, { code: 'oo||', plant: 'Kale Sprouts' }], crops: [{ slot: 6, code: 'oo||', plant: 'x' }] }
    render(<PodCodes />)
    fireEvent.click(screen.getByRole('button', { name: 'Share pod codes' }))
    const panel = screen.getByTestId('share-pod-codes')
    expect(panel.textContent).toContain('None of your confirmed codes is a plant in the catalog')
    expect(panel.textContent).toContain('Genovese Basil, Kale Sprouts')
    expect(within(panel).queryByRole('link')).toBeNull()
  })

  it('shares several codes, without crops when none was read', () => {
    state.data = { available: true, pods: [], pairs: [{ code: 'oo||', plant: 'Basil', confirmedAt: 't' }, { code: 'o|hh', plant: 'Thyme', confirmedAt: 't' }] }
    state.share = { url: 'https://github.com/x', pairs: [{ code: 'oo||', plant: 'Basil' }, { code: 'o|hh', plant: 'Thyme' }], skipped: [], crops: [] }
    render(<PodCodes />)
    fireEvent.click(screen.getByRole('button', { name: 'Share pod codes' }))
    const panel = screen.getByTestId('share-pod-codes')
    expect(panel.textContent).toContain('your 2 confirmed codes,')
    expect(panel.textContent).not.toContain('Left out')
    expect(panel.textContent).not.toContain('Crops')
  })

  it('corrects a code to another plant, offering the plants it knows', () => {
    state.data = { available: true, pods: [pod(6, 'oo||', null, 'Basil')], pairs: [{ code: 'ooh|', plant: 'Chives', confirmedAt: 't' }] }
    render(<PodCodes />)
    fireEvent.click(screen.getByRole('button', { name: 'Correct pod 6' }))
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
