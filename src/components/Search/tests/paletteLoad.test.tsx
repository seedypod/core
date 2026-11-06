// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../CommandPalette'

const { load } = vi.hoisted(() => ({ load: { fail: false } }))

// Loads fail in the component, not the factory, which vitest runs only once; a throw there reaches the boundary just as a rejected import does.
vi.mock('../PaletteBody', () => ({
  PaletteBody: () => {
    if (load.fail) throw new Error('chunk gone')
    return <input aria-label="Search box" />
  },
}))

beforeEach(() => {
  load.fail = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CommandPalette when its body fails to load', () => {
  it('says so inside the dialog, with the page behind it intact', async () => {
    render(
      <main>
        page
        <CommandPalette open onClose={vi.fn()} />
      </main>
    )
    expect((await screen.findByRole('alert')).textContent).toContain('Search didn\'t load')
    expect(screen.getByRole('main').textContent).toContain('page')
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
  })

  it('closes as usual', async () => {
    const onClose = vi.fn()
    render(<CommandPalette open onClose={onClose} />)
    await screen.findByRole('alert')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('loads on a retry once the connection is back, and keeps offering it until then', async () => {
    render(<CommandPalette open onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await screen.findByRole('alert')
    load.fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Search box')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
