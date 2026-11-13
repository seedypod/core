// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LightStops } from '../LightStops'

afterEach(cleanup)

/** A 218 px track: the stops sit 40 px apart from 9 px in. */
function track() {
  const el = screen.getByTestId('light-stops')
  el.getBoundingClientRect = () => ({ left: 0, width: 218, top: 0, height: 18, right: 218, bottom: 18, x: 0, y: 0, toJSON: () => ({}) })
  return el
}
const at = (stop: number) => ({ clientX: 9 + stop * 40, pointerId: 1, button: 0 })

describe('LightStops', () => {
  it('previews each level a drag crosses and picks the stop it is let go on', () => {
    const onPreview = vi.fn()
    const onPick = vi.fn()
    render(<LightStops value="auto" auto onPreview={onPreview} onPick={onPick} />)
    const el = track()
    fireEvent.pointerDown(el, at(0))
    fireEvent.pointerMove(el, at(2))
    fireEvent.pointerMove(el, at(3))
    expect(screen.getByLabelText('Brightness').getAttribute('aria-valuetext')).toBe('50%')
    expect(screen.getByTestId('stops-thumb').style.left).toBe('calc(60% - 9px)')
    fireEvent.pointerUp(el, at(3))
    expect(onPreview.mock.calls.map(c => c[0])).toEqual([25, 50])
    expect(onPick).toHaveBeenCalledWith(50)
    // Let go, it shows the value it's given until that changes.
    expect(screen.getByTestId('stops-auto').dataset.on).toBe('true')
  })

  it('picks the stop it previewed once the page shows that preview as its value', () => {
    const onPick = vi.fn()
    const { rerender } = render(<LightStops value={50} auto={false} onPreview={vi.fn()} onPick={onPick} />)
    const el = track()
    fireEvent.pointerDown(el, at(2))
    rerender(<LightStops value={25} auto={false} onPreview={vi.fn()} onPick={onPick} />)
    fireEvent.pointerUp(el, at(2))
    expect(onPick).toHaveBeenCalledWith(25)
  })

  it('picks nothing when a drag ends where it started, or is cancelled, and lets go of its preview', () => {
    const onPick = vi.fn()
    const onPreview = vi.fn()
    render(<LightStops value={25} auto={false} onPreview={onPreview} onPick={onPick} />)
    const el = track()
    fireEvent.pointerDown(el, at(2))
    fireEvent.pointerUp(el, at(2))
    fireEvent.pointerDown(el, at(2))
    fireEvent.pointerMove(el, at(5))
    fireEvent.pointerCancel(el, at(5))
    expect(onPick).not.toHaveBeenCalled()
    expect(onPreview).toHaveBeenLastCalledWith(null)
    expect(screen.getByLabelText('Brightness').getAttribute('aria-valuetext')).toBe('25%')
  })

  it('draws Auto as a ring when it isn\'t running the light, the thumb grey at Off, and a level between stops as itself', () => {
    render(<LightStops value={0} auto={false} onPreview={vi.fn()} onPick={vi.fn()} />)
    expect(screen.getByTestId('stops-auto').dataset.on).toBeUndefined()
    expect(screen.getByTestId('stops-thumb').className).toContain('bg-fg-3')
    cleanup()
    render(<LightStops value={40} auto onPreview={vi.fn()} onPick={vi.fn()} />)
    expect(screen.getByLabelText('Brightness').getAttribute('aria-valuetext')).toBe('40%')
    expect(screen.getByTestId('stops-thumb').className).toContain('bg-fg')
  })

  it('picks Auto from the keyboard without previewing a level', () => {
    const onPreview = vi.fn()
    const onPick = vi.fn()
    render(<LightStops value={0} auto onPreview={onPreview} onPick={onPick} />)
    fireEvent.change(screen.getByLabelText('Brightness'), { target: { value: '0' } })
    expect(onPick).toHaveBeenCalledWith('auto')
    expect(onPreview).not.toHaveBeenCalled()
  })
})
