import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { StatusPage } from '@/src/components/System/StatusPage'
import { Route as ScheduleRoute } from '@/web/src/routes/schedule'
import { Route as StatusRoute } from '@/web/src/routes/status'
import { NAV_GROUPS, navItems } from '../navItems'

describe('navItems', () => {
  it('puts Home, Grow, Light, Water and Settings in the mobile tab bar', () => {
    expect(navItems.filter(i => i.tab).map(i => i.label)).toEqual(['Home', 'Grow', 'Light', 'Water', 'Settings'])
  })

  it('lists System after Observe with Status, then Sensors moved from Observe; Alerts and Settings sit at the foot', () => {
    expect(NAV_GROUPS.map(g => g.label)).toEqual(['Garden', 'Control', 'Observe', 'System'])
    const labels = (group: string) => navItems.filter(i => i.group === group).map(i => i.label)
    expect(labels('observe')).toEqual(['Cameras', 'Analysis'])
    expect(labels('system')).toEqual(['Status', 'Sensors'])
    expect(labels('foot')).toEqual(['Alerts', 'Settings'])
    // Health, History and Storage stay out until their pages ship.
    expect(navItems.some(i => ['Health', 'History', 'Storage'].includes(i.label))).toBe(false)
    expect(StatusRoute.options.component).toBe(StatusPage)
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
