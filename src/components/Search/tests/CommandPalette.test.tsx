// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '@/src/components/ds/feedback'
import { SidebarSearch } from '../CommandPalette'
import { DOCS_BASE, DOCS_INDEX_URL, resetLiveDocsIndex } from '../docsIndex'

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
/** The dialog's body is a lazy chunk, so it lands a tick after the click. */
const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  await screen.findByRole('combobox')
}
const docsOptions = () => screen.queryAllByRole('option').filter(o => o.textContent?.includes('Docs › User guide'))

const fetchMock = vi.fn<typeof fetch>()
const docsPage = (title: string) => ({ path: '/live/', title, section: 'User guide', description: '', headings: [], keywords: '' })
const respond = (body: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

beforeEach(() => {
  navigate.mockClear()
  data.clear()
  data.set('pods', [{ slot: 5, plant: 'Cherry Tomato', status: 'attention', notes: '' }])
  data.set('rules', [{ id: 1, name: 'Tank getting low', enabled: true, dryRun: false }])
  resetLiveDocsIndex()
  fetchMock.mockReset().mockRejectedValue(new TypeError('offline'))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

  it.each([{ metaKey: true }, { ctrlKey: true }])('opens from anywhere with %o + K and toggles closed again', async (mod) => {
    render(<SidebarSearch />)
    fireEvent.keyDown(document.body, { key: 'k', ...mod })
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
    await screen.findByRole('combobox')
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

  it('lists the top-level pages before typing', async () => {
    render(<SidebarSearch />)
    await open()
    const pages = within(screen.getByRole('listbox', { name: 'Pages' })).getAllByRole('option').map(o => o.textContent)
    expect(pages[0]).toMatch(/^Home/)
    expect(pages.some(p => p?.startsWith('Grow'))).toBe(true)
    expect(pages.some(p => p?.startsWith('Kiosk'))).toBe(false)
  })

  it('finds a plant with its breadcrumb and goes to its pod on Enter, then closes and refocuses the opener', async () => {
    render(<SidebarSearch />)
    const opener = screen.getByRole('button', { name: 'Search' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole('combobox')
    fireEvent.change(input(), { target: { value: 'tomato' } })
    expect(screen.getAllByRole('option')[0]?.textContent).toBe('Cherry TomatoGrow › Pod 5')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith({ href: '/grow?pod=5' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('moves through results with the arrow keys, wrapping at both ends, and opens one on click', async () => {
    render(<SidebarSearch />)
    await open()
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

  it('says when nothing matches, does nothing on Enter, and resets when reopened', async () => {
    render(<SidebarSearch />)
    await open()
    fireEvent.change(input(), { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toContain('No matches')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await open()
    expect((input() as HTMLInputElement).value).toBe('')
  })

  it('keeps Tab focus inside the dialog', async () => {
    render(<SidebarSearch />)
    await open()
    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
  })

  it('searches the bundled docs snapshot offline, with an external-link indicator', async () => {
    render(<SidebarSearch />)
    await open()
    fireEvent.change(input(), { target: { value: 'debugging' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const docs = docsOptions()
    expect(docs[0]?.textContent).toMatch(/^Debugging/)
    expect(within(docs[0] as HTMLElement).getByText('Opens the docs in a new tab')).toBeTruthy()
    expect((docs[0] as HTMLElement).querySelectorAll('svg')).toHaveLength(2)
  })

  it('fetches the live index without credentials and only once per page load', async () => {
    render(<SidebarSearch />)
    await open()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0]?.[0]).toBe(DOCS_INDEX_URL)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    fireEvent.keyDown(input(), { key: 'Escape' })
    await open()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('leaves docs out of the page list before typing', async () => {
    render(<SidebarSearch />)
    await open()
    expect(screen.getAllByRole('option').some(o => o.textContent?.includes('Docs'))).toBe(false)
  })

  it('ranks a setting above the docs page that covers it', async () => {
    render(<SidebarSearch />)
    await open()
    fireEvent.change(input(), { target: { value: 'backup' } })
    expect(screen.getAllByRole('option')[0]?.textContent).toBe('BackupSettings')
  })

  it('uses a valid live index for the session', async () => {
    respond({ version: 1, generatedAt: '2026-11-01T00:00:00Z', base: DOCS_BASE, pages: [docsPage('Zeppelin mooring')] })
    render(<SidebarSearch />)
    await open()
    fireEvent.change(input(), { target: { value: 'zeppelin' } })
    expect(await screen.findByRole('option', { name: /Zeppelin mooring/ })).toBeTruthy()
  })

  it.each([
    ['breaks the contract', () => respond({ version: 2, generatedAt: '2026-11-01T00:00:00Z', base: DOCS_BASE, pages: [docsPage('Zeppelin mooring')] })],
    ['is not found', () => fetchMock.mockResolvedValue(new Response('Not found', { status: 404 }))],
  ])('keeps the snapshot when the live index %s', async (_, arrange) => {
    arrange()
    render(<SidebarSearch />)
    await open()
    fireEvent.change(input(), { target: { value: 'zeppelin' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByRole('option')).toBeNull()
    fireEvent.change(input(), { target: { value: 'debugging' } })
    expect(docsOptions().length).toBeGreaterThan(0)
  })

  it.each(['Enter', 'click'])('opens a docs result in a new tab on %s without navigating the app', async (how) => {
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<SidebarSearch />)
    await open()
    fireEvent.change(input(), { target: { value: 'debugging' } })
    const option = screen.getAllByRole('option')[0] as HTMLElement
    expect(option.textContent).toContain('Docs')
    if (how === 'Enter') fireEvent.keyDown(input(), { key: 'Enter' })
    else fireEvent.click(option)
    expect(openWindow).toHaveBeenCalledWith(`${DOCS_BASE}/core/debugging/`, '_blank', 'noopener,noreferrer')
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    openWindow.mockRestore()
  })
})
