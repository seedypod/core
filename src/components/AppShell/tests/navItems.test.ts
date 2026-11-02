import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { Route as ScheduleRoute } from '@/web/src/routes/schedule'
import { navItems } from '../navItems'

describe('navItems', () => {
  it('puts Home, Grow, Light, Water and Settings in the mobile tab bar', () => {
    expect(navItems.filter(i => i.tab).map(i => i.label)).toEqual(['Home', 'Grow', 'Light', 'Water', 'Settings'])
  })

  it('has no Schedule page; its old links land on Light', () => {
    expect(navItems.some(i => i.to === '/schedule')).toBe(false)
    let thrown: unknown
    try {
      (ScheduleRoute.options.beforeLoad as () => void)()
    }
    catch (e) {
      thrown = e
    }
    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options: { to: string } }).options.to).toBe('/light')
  })
})
