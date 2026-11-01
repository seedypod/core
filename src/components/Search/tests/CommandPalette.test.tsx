// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '@/src/components/ds/feedback'
import { SidebarSearch } from '../CommandPalette'

const { navigate, data } = vi.hoisted(() => ({ navigate: vi.fn(), data: new Map<string, unknown>() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    grow: { pods: { useQuery: () => ({ data: data.get('pods') }) } },
    automations: { list: { useQuery: () => ({ data: data.get('rules') }) } },
  },
}))

const input = () => screen.getByRole('combobox', { name: 'Search pages, settings, plants and rules' })
const selected = () => screen.getAllByRole('option').find(o => o.getAttribute('aria-selected') === 'true')
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Search' }))

beforeEach(() => {
  navigate.mockClear()
  data.clear()
  data.set('pods', [{ slot: 5, plant: 'Cherry Tomato', status: 'attention', notes: '' }])
  data.set('rules', [{ id: 1, name: 'Tank getting low', enabled: true, dryRun: false }])
})
afterEach(cleanup)

describe('SidebarSearch', () => {
  it('shows the search box with a Ctrl K hint off Apple platforms, and ⌘K on a Mac', () => {
    const { unmount } = render(<SidebarSearch />)
    const button = screen.getByRole('button', { name: 'Search' })
    expect(button.textContent).toContain('Ctrl K')
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+K')
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    render(<SidebarSearch />)
    expect(screen.getByRole('button', { name: 'Search' }).textContent).toContain('⌘K')
    platform.mockRestore()
  })

  it.each([{ metaKey: true }, { ctrlKey: true }])('opens from anywhere with %o + K and toggles closed again', (mod) => {
    render(<SidebarSearch />)
    fireEvent.keyDown(document.body, { key: 'k', ...mod })
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(document.body, { key: 'K', ...mod })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not open over another open modal, and ignores K without a modifier or with Shift', () => {
    const onClose = vi.fn()
    render(
      <>
        <SidebarSearch />
        <Modal open onClose={onClose} title="Pod 5"><p>body</p></Modal>
      </>,
    )
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    cleanup()
    render(<SidebarSearch />)
    fireEvent.keyDown(document.body, { key: 'k' })
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true, shiftKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists the top-level pages before typing', () => {
    render(<SidebarSearch />)
    open()
    const pages = within(screen.getByRole('listbox', { name: 'Pages' })).getAllByRole('option').map(o => o.textContent)
    expect(pages[0]).toMatch(/^Home/)
    expect(pages.some(p => p?.startsWith('Grow'))).toBe(true)
    expect(pages.some(p => p?.startsWith('Kiosk'))).toBe(false)
  })

  it('finds a plant with its breadcrumb and goes to its pod on Enter, then closes and refocuses the opener', () => {
    render(<SidebarSearch />)
    const opener = screen.getByRole('button', { name: 'Search' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.change(input(), { target: { value: 'tomato' } })
    expect(screen.getAllByRole('option')[0]?.textContent).toBe('Cherry TomatoGrow › Pod 5')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith({ href: '/grow?pod=5' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('moves through results with the arrow keys, wrapping at both ends, and opens one on click', () => {
    render(<SidebarSearch />)
    open()
    fireEvent.change(input(), { target: { value: 'tank' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    expect(selected()).toBe(options[0])
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selected()).toBe(options[1])
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1]?.id)
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(selected()).toBe(options[options.length - 1])
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selected()).toBe(options[0])
    fireEvent.click(options[0] as HTMLElement)
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('says when nothing matches, does nothing on Enter, and resets when reopened', () => {
    render(<SidebarSearch />)
    open()
    fireEvent.change(input(), { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toContain('No matches')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    expect((input() as HTMLInputElement).value).toBe('')
  })

  it('keeps Tab focus inside the dialog', () => {
    render(<SidebarSearch />)
    open()
    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
  })
})
