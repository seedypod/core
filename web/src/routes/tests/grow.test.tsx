// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { search } = vi.hoisted(() => ({ search: { current: {} as Record<string, unknown> } }))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options, useSearch: () => search.current }),
}))
vi.mock('@/src/components/Grow/GrowPage', () => ({
  GrowPage: ({ tab, pod }: { tab?: string, pod?: number }) => <div data-testid="grow">{`${tab ?? '-'} ${pod ?? '-'}`}</div>,
  isGrowTab: (v: unknown) => v === 'protocol' || v === 'pods',
}))

const { Route } = await import('../grow')
const { validateSearch, component: Grow } = (Route as unknown as { options: { validateSearch: (s: Record<string, unknown>) => unknown, component: ComponentType } }).options

afterEach(cleanup)

describe('/grow', () => {
  it('keeps a whole positive ?pod and a known ?tab, and drops anything else', () => {
    expect(validateSearch({ pod: '4', tab: 'protocol' })).toEqual({ pod: 4, tab: 'protocol' })
    expect(validateSearch({ pod: '0', tab: 'tower' })).toEqual({})
    expect(validateSearch({ pod: '2.5' })).toEqual({})
  })

  it('hands the page the tab and pod from the link', () => {
    search.current = { tab: 'pods', pod: 3 }
    render(<Grow />)
    expect(screen.getByTestId('grow').textContent).toBe('pods 3')
  })
})
