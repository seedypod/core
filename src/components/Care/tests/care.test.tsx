// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CarePage } from '../CarePage'
import { careLine } from '../CareSummary'

const { data, opened } = vi.hoisted(() => ({ data: new Map<string, unknown>(), opened: { draft: null as unknown } }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, hash, ...rest }: { children: ReactNode, to: string, hash?: string }) => <a href={hash ? `${to}#${hash}` : to} {...rest}>{children}</a>,
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { care: { setup: { useQuery: () => ({ data: data.get('setup') }) } } },
}))
// Each has its own tests; here they only need to be on the page, and the starter to open the editor.
vi.mock('@/src/components/Water/Chores', () => ({ Chores: () => <div data-testid="chores" /> }))
vi.mock('@/src/components/Water/TankLog', () => ({ TankLog: () => <div data-testid="tank-log" /> }))
vi.mock('@/src/components/Autopilot/StarterRules', () => ({
  StarterRules: ({ onOpen }: { onOpen: (d: unknown) => void }) => <button type="button" onClick={() => onOpen({ name: 'Tank below half' })}>starter</button>,
}))
vi.mock('@/src/components/Autopilot/RuleEditor', () => ({
  RuleEditor: ({ initial, onClose }: { initial: unknown, onClose: () => void }) => {
    opened.draft = initial
    return <button type="button" onClick={onClose}>close editor</button>
  },
}))

beforeEach(() => {
  data.clear()
  opened.draft = null
})
afterEach(cleanup)

describe('CarePage', () => {
  it('collects the setup check, chores, tank log, starter rules and the assistant', () => {
    data.set('setup', { planted: 12, issues: [{ id: 'no_pump_schedule', alert: 'setup_pump_schedule', title: 'No pump schedule', detail: '12 pods are planted and no pump cycle is on.', fix: 'Water → Pump cycles' }], summary: '' })
    render(<CarePage />)
    const issue = within(screen.getByTestId('setup-no_pump_schedule'))
    expect(issue.getByText('No pump schedule')).toBeTruthy()
    expect(issue.getByText('Water → Pump cycles')).toBeTruthy()
    expect(screen.getByTestId('chores')).toBeTruthy()
    expect(screen.getByTestId('tank-log')).toBeTruthy()
    expect(screen.getByTestId('mcp-command').textContent).toBe(`claude mcp add --transport http seedypod ${window.location.origin}/api/mcp`)
    expect(screen.getByRole('link', { name: 'Settings → API access' }).getAttribute('href')).toBe('/settings#api')
  })

  it('says when the setup is complete', () => {
    data.set('setup', { planted: 12, issues: [], summary: '12 pods planted, with light and pump schedules on and a tank sensor reading good.' })
    render(<CarePage />)
    expect(screen.getByTestId('setup').textContent).toContain('12 pods planted')
  })

  it('opens a starter rule in the editor here, and closes it', () => {
    render(<CarePage />)
    fireEvent.click(screen.getByText('starter'))
    expect(opened.draft).toEqual({ name: 'Tank below half' })
    fireEvent.click(screen.getByText('close editor'))
    expect(screen.queryByText('close editor')).toBeNull()
  })
})

describe('careLine', () => {
  const c = (title: string, state: string) => ({ title, state })
  it('leads with what is due, then what is soon, then nothing', () => {
    expect(careLine([c('Top off the tank', 'due'), c('Feed', 'due'), c('Thin seedlings', 'soon')], 0)).toEqual({ text: 'Top off the tank and Feed due', tone: 'due' })
    expect(careLine([c('Feed', 'soon'), c('Clean', 'ok')], 0)).toEqual({ text: 'Feed soon', tone: 'soon' })
    expect(careLine([c('Feed', 'ok')], 0)).toEqual({ text: 'Nothing due', tone: 'ok' })
  })

  it('shortens a long list and counts setup issues, which make it urgent', () => {
    expect(careLine([c('A', 'due'), c('B', 'due'), c('C', 'due'), c('D', 'due')], 2).text).toBe('A, B +2 due · 2 setup issues')
    expect(careLine([], 1)).toEqual({ text: 'Nothing due · 1 setup issue', tone: 'due' })
  })
})
