// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardPlace, PodCard, stateGuess, type Pod } from '../PodCard'
import type { PodStory } from '../pods'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, ...rest }: { children: ReactNode, to: string, search?: { pod: number } }) => <a href={search ? `${to}?pod=${search.pod}` : to} {...rest}>{children}</a>,
}))

afterEach(cleanup)

describe('stateGuess', () => {
  it('names the likeliest state, and the runner-up when it is close enough to matter', () => {
    expect(stateGuess({ value: 1, detail: { probabilities: { empty: 0, sprouted: 0.901, unhealthy: 0.061 } } })).toBe('sprouted 90%')
    expect(stateGuess({ value: 0, detail: { probabilities: { empty: 0.492, sprouted: 0.445, growing: 0.007 } } })).toBe('empty 49% · sprouted 45%')
  })

  it('falls back to the state and confidence, or the class index', () => {
    expect(stateGuess({ value: 2, detail: { state: 'growing', confidence: 0.87 } })).toBe('growing 87%')
    expect(stateGuess({ value: 2, detail: { probabilities: { growing: 'high' } } })).toBe('growing')
    expect(stateGuess({ value: 9, detail: null })).toBe('class 9')
  })
})

describe('cardPlace', () => {
  it('puts the card under a pod in the top half and over one in the bottom half, on the side that keeps it in the photo', () => {
    const high = cardPlace({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
    expect(Object.keys(high).sort()).toEqual(['left', 'top'])
    expect(parseFloat(high.top as string)).toBeCloseTo(30)
    expect(parseFloat(high.left as string)).toBeCloseTo(10)
    const low = cardPlace({ x: 0.6, y: 0.6, w: 0.2, h: 0.2 })
    expect(Object.keys(low).sort()).toEqual(['bottom', 'right'])
    expect(parseFloat(low.bottom as string)).toBeCloseTo(40)
    expect(parseFloat(low.right as string)).toBeCloseTo(20)
  })
})

describe('PodCard with a story', () => {
  const pod: Pod = { slot: 21, plant: 'Red Swiss Chard', plantedAt: '2026-01-01', status: 'seeded', notes: '', updatedAt: '2026-01-01T00:00:00Z', statusSince: null, lastHarvestAt: null }
  const trend = { slot: 21, green: 0.01, verdict: 'stalled' as const, slope: 0, samples: 3, recent: [0, 0.01, 0.01] }
  const story = (over: Partial<PodStory> = {}): PodStory => ({ state: { stage: 'seeded', from: 'carry', at: '2026-01-05T08:00:00Z', by: null, confidence: null }, day: 22, window: { days: [7, 21], estimated: false }, sprout: 'late', code: null, ...over })
  const card = (s: PodStory, onRelabel = vi.fn(), p = pod) => render(<PodCard slot={21} box={{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }} pod={p} trend={trend} readings={[]} pinned onClose={vi.fn()} story={s} onRelabel={onRelabel} />)

  it('leads with the state and the sprouting window, amber when the pod is late', () => {
    card(story())
    const c = screen.getByRole('dialog', { name: 'Pod 21' })
    expect(c.textContent).toContain('Seeded')
    expect(screen.getByText('day 22 · late').className).toContain('text-warn')
    expect(screen.getByText('day 7–21 typical').className).toContain('text-warn')
    expect(c.textContent).toContain('leaf cover1% ↑ from 0%')
    expect(c.textContent).toMatch(/labelyou · /)
    expect(c.textContent).not.toContain('code')
    // The story replaces the record's status line.
    expect(c.textContent).not.toContain('Seeded · day')
  })

  it('shows a confirmed code, opens the pod and relabels it', () => {
    const relabel = vi.fn()
    card(story({ sprout: 'on time', day: 8, code: 'oo/h' }), relabel)
    expect(screen.getByText('day 8 · on time').className).not.toContain('text-warn')
    expect(screen.getByLabelText('open, open, slanted bar, half, solid')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open pod' }).getAttribute('href')).toBe('/grow?pod=21')
    fireEvent.click(screen.getByRole('button', { name: 'Relabel' }))
    expect(relabel).toHaveBeenCalled()
  })

  it('keeps an empty pod to its number, name and state', () => {
    card(story({ state: { stage: 'empty', from: 'record', at: null, by: null, confidence: null }, day: null, window: null, sprout: null }), vi.fn(), { ...pod, plant: null, plantedAt: null, status: 'empty' })
    const c = screen.getByRole('dialog', { name: 'Pod 21' })
    expect(c.textContent).toContain('Empty')
    expect(c.textContent).not.toContain('leaf cover')
  })
})
