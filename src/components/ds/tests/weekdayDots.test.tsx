// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WeekdayDots } from '../forms'

afterEach(cleanup)

describe('WeekdayDots', () => {
  it('lights a schedule\'s days Monday-first and sums them up', () => {
    render(<WeekdayDots days={0b10101} />)
    const week = screen.getByTestId('weekday-dots')
    expect(week.getAttribute('aria-label')).toBe('Runs on Mon, Wed, Fri')
    expect([...week.querySelectorAll('[aria-hidden] > span')].map(d => `${d.textContent}${d.hasAttribute('data-on') ? '*' : ''}`)).toEqual(['M*', 'T', 'W*', 'T', 'F*', 'S', 'S'])
    expect(screen.getByText('Mon, Wed, Fri')).toBeTruthy()
  })

  it('can leave the summary out', () => {
    render(<WeekdayDots days={1} summary={false} />)
    expect(screen.getByTestId('weekday-dots').getAttribute('aria-label')).toBe('Runs on Mondays')
    expect(screen.queryByText('Mondays')).toBeNull()
  })
})
