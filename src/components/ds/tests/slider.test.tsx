// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Slider } from '../forms'

afterEach(cleanup)

/** A 200 px track from x = 100, so a percent is 2 px. */
function setup(start = 40, props: { disabled?: boolean, min?: number, max?: number, step?: number } = {}) {
  const changes: number[] = []
  const commits: number[] = []
  function Host() {
    const [v, setV] = useState(start)
    return (
      <Slider
        label="Brightness"
        value={v}
        onChange={(n) => {
          changes.push(n)
          setV(n)
        }}
        onCommit={n => commits.push(n)}
        {...props}
      />
    )
  }
  render(<Host />)
  const input = screen.getByLabelText('Brightness') as HTMLInputElement
  const hit = screen.getByTestId('slider-hit')
  const root = hit.parentElement as HTMLElement
  root.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect
  return { input, hit, root, changes, commits }
}

const at = (pct: number, pointerId = 1) => ({ clientX: 100 + pct * 2, pointerId, button: 0 })

describe('Slider by pointer', () => {
  it('jumps to a tap anywhere on the track at once, and commits once on lift', () => {
    const { input, hit, changes, commits } = setup()
    fireEvent.pointerDown(hit, at(75))
    expect(input.value).toBe('75')
    expect(commits).toEqual([])
    fireEvent.pointerUp(hit, at(75))
    expect(changes).toEqual([75])
    expect(commits).toEqual([75])
  })

  it('follows a drag and commits only the end of it', () => {
    const { input, hit, changes, commits } = setup()
    fireEvent.pointerDown(hit, at(40))
    for (const p of [50, 60, 60, 70]) fireEvent.pointerMove(hit, at(p))
    expect(input.value).toBe('70')
    fireEvent.pointerUp(hit, at(70))
    expect(changes).toEqual([50, 60, 70])
    expect(commits).toEqual([70])
  })

  it('clamps to the ends when a drag runs past them', () => {
    const { hit, commits } = setup()
    fireEvent.pointerDown(hit, at(90))
    fireEvent.pointerMove(hit, at(130))
    fireEvent.pointerUp(hit, at(130))
    fireEvent.pointerDown(hit, at(10))
    fireEvent.pointerMove(hit, at(-30))
    fireEvent.pointerUp(hit, at(-30))
    expect(commits).toEqual([100, 0])
  })

  it('snaps to the step', () => {
    const { hit, commits } = setup(10, { min: 10, max: 30, step: 5 })
    fireEvent.pointerDown(hit, at(60))
    fireEvent.pointerUp(hit, at(60))
    expect(commits).toEqual([20])
  })

  it('goes back to where it was, committing nothing, when a touch turns into a scroll', () => {
    const { input, hit, changes, commits } = setup()
    fireEvent.pointerDown(hit, at(80))
    expect(input.value).toBe('80')
    fireEvent.pointerCancel(hit, at(80))
    expect(input.value).toBe('40')
    expect(changes).toEqual([80, 40])
    expect(commits).toEqual([])
    fireEvent.pointerUp(hit, at(80))
    expect(commits).toEqual([])
  })

  it('restores the same way if it loses the pointer some other way', () => {
    const { input, root, hit } = setup()
    fireEvent.pointerDown(hit, at(80))
    fireEvent.lostPointerCapture(root, at(80))
    expect(input.value).toBe('40')
  })

  it('does nothing on cancel when the touch moved nothing', () => {
    const { hit, changes } = setup()
    fireEvent.pointerDown(hit, at(40))
    fireEvent.pointerCancel(hit, at(40))
    expect(changes).toEqual([])
  })

  it('sends nothing for a tap on the value it already has, or a drag back to it', () => {
    const { hit, commits } = setup()
    fireEvent.pointerDown(hit, at(40))
    fireEvent.pointerUp(hit, at(40))
    expect(commits).toEqual([])
    fireEvent.pointerDown(hit, at(40))
    fireEvent.pointerMove(hit, at(60))
    fireEvent.pointerMove(hit, at(40))
    fireEvent.pointerUp(hit, at(40))
    expect(commits).toEqual([])
  })

  it('stays with the first finger, ignores a right click, and a pointer that never pressed', () => {
    const { hit, changes, commits } = setup()
    fireEvent.pointerMove(hit, at(90))
    fireEvent.pointerDown(hit, { ...at(90), button: 2 })
    expect(changes).toEqual([])
    fireEvent.pointerDown(hit, at(50, 1))
    fireEvent.pointerDown(hit, at(90, 2))
    fireEvent.pointerMove(hit, at(90, 2))
    fireEvent.pointerUp(hit, at(90, 2))
    expect(commits).toEqual([])
    fireEvent.pointerUp(hit, at(50, 1))
    expect(commits).toEqual([50])
  })

  it('captures the pointer so a finger straying off the track keeps driving it, and focuses the input for keys', () => {
    const { input, hit, root } = setup()
    const capture = vi.fn()
    root.setPointerCapture = capture
    fireEvent.pointerDown(hit, at(60))
    expect(capture).toHaveBeenCalledWith(1)
    expect(document.activeElement).toBe(input)
  })

  it('ignores a disabled slider', () => {
    const { hit, changes } = setup(40, { disabled: true })
    fireEvent.pointerDown(hit, at(80))
    expect(changes).toEqual([])
  })

  it('leaves vertical swipes to the page, and gives a finger 44 px', () => {
    const { input, hit, root } = setup()
    expect(root.className).toContain('touch-pan-y')
    expect(hit.className).toContain('-inset-y-[13px]')
    expect(input.className).toContain('pointer-events-none')
  })
})

describe('Slider by keyboard and screen reader', () => {
  const press = (input: HTMLInputElement, ...values: string[]) => {
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    for (const value of values) {
      fireEvent.input(input, { target: { value } })
      fireEvent.change(input, { target: { value } })
    }
  }

  it('stays the semantic control', () => {
    const { input } = setup()
    expect(screen.getByRole('slider', { name: 'Brightness' })).toBe(input)
    expect(input.value).toBe('40')
  })

  it('commits once when a held key is released', () => {
    const { input, commits } = setup()
    press(input, '41', '42', '43')
    expect(commits).toEqual([])
    fireEvent.keyUp(input, { key: 'ArrowRight' })
    expect(commits).toEqual([43])
  })

  it('sends nothing when Tab lands on it', () => {
    const { input, commits } = setup()
    fireEvent.keyUp(input, { key: 'Tab' })
    expect(commits).toEqual([])
  })

  it('commits an adjustment still open when focus leaves, once', () => {
    const { input, commits } = setup()
    press(input, '41', '42')
    fireEvent.blur(input)
    expect(commits).toEqual([42])
    fireEvent.keyUp(input, { key: 'ArrowRight' })
    expect(commits).toEqual([42])
  })

  it('still hears a screen reader after Tab took focus before its keyup', () => {
    const { input, commits } = setup()
    fireEvent.keyDown(input, { key: 'Tab' })
    fireEvent.blur(input)
    expect(commits).toEqual([])
    fireEvent.input(input, { target: { value: '45' } })
    fireEvent.change(input, { target: { value: '45' } })
    expect(commits).toEqual([45])
  })

  it('commits a screen reader\'s adjustment, which has no key to release', () => {
    const { input, commits } = setup()
    fireEvent.input(input, { target: { value: '45' } })
    fireEvent.change(input, { target: { value: '45' } })
    expect(commits).toEqual([45])
  })
})
