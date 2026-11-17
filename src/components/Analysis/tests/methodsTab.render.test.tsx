// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MethodsTab } from '../MethodsTab'

const { data, podLabels } = vi.hoisted(() => ({ data: new Map<string, unknown>(), podLabels: vi.fn() }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: (input?: { metric?: string }, opts?: { enabled?: boolean }) => {
    if (name === 'podLabels') podLabels(input, opts)
    const answer = data.get(name === 'compare' ? `compare:${input?.metric}` : name)
    return { data: opts?.enabled === false ? undefined : answer }
  } })
  const mutation = () => ({ useMutation: () => ({ isPending: false, error: null, mutate: vi.fn() }) })
  return {
    apiBase: () => '',
    trpc: {
      useUtils: () => ({ vision: { invalidate: vi.fn() } }),
      vision: { compare: query('compare'), podLabels: query('podLabels'), agreement: query('agreement'), setPrimary: mutation(), rerun: mutation() },
      camera: { list: query('frames'), get: query('still') },
    },
  }
})

const series = (version: number, ...values: number[]) => ({
  analyzer: 'exg-otsu',
  version,
  source: 'device',
  points: values.map((value, i) => ({ ts: `2026-01-0${i + 1}T00:00:00Z`, value, captureId: `c${i}` })),
})
const show = (status: 'seeded' | 'growing') => render(
  <MethodsTab analyzers={[]} colorOf={() => 'red'} busy={false} slot={1} onSlot={() => {}} pods={[{ slot: 1, plant: 'Kale', status, plantedAt: '2026-01-01', notes: '' }] as never} trends={[]} boxes={() => ({})} />,
)

beforeEach(() => {
  data.clear()
  podLabels.mockReset()
  data.set('compare:green_fraction', [series(1, 0.05, 0.03, 0.01, 0.2), series(2, 0, 0.01, 0, 0.3)])
})
afterEach(cleanup)

describe('One pod over time against the labels', () => {
  it('asks for the pod\'s labels over the chart\'s window and reads the lines against them', () => {
    data.set('podLabels', [
      { captureId: 'c0', ts: '2026-01-01T00:00:00Z', label: 'seeded', source: 'picked' },
      { captureId: 'c1', ts: '2026-01-02T00:00:00Z', label: 'seeded', source: 'picked' },
      { captureId: 'c2', ts: '2026-01-03T00:00:00Z', label: 'seeded', source: 'accepted' },
      { captureId: 'c3', ts: '2026-01-04T00:00:00Z', label: 'growing', source: 'picked' },
    ])
    show('growing')
    expect(podLabels).toHaveBeenLastCalledWith({ slot: 1, from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z', limit: 200 }, { enabled: true })
    expect(screen.getByText('exg-otsu@1 read over 2% on 2 of 3 photos you labelled seeded; exg-otsu@2 agrees.')).toBeTruthy()
    // Where the label changes, on the chart.
    expect(screen.getAllByTestId('chart-marker').map(m => m.textContent)).toEqual(['seeded', 'growing'])
  })

  it('reads against the pod\'s record when no charted photo is labelled', () => {
    data.set('podLabels', [])
    show('seeded')
    expect(screen.getByText('Every version reads plant on this seeded pod at times: exg-otsu@1 up to 20% and exg-otsu@2 up to 30%.')).toBeTruthy()
    expect(screen.queryAllByTestId('chart-marker')).toEqual([])
  })

  it('waits for the chart before asking for labels', () => {
    data.set('compare:green_fraction', [])
    show('seeded')
    expect(podLabels).toHaveBeenLastCalledWith({ slot: 1, from: undefined, to: undefined, limit: 200 }, { enabled: false })
  })
})
