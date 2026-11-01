import { Bell, Camera, CalendarClock, Cpu, Droplets, LayoutDashboard, Leaf, ScanEye, Settings, Sun, Wand2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** The sidebar section it's listed under; `system` sits at the foot. */
  group: 'garden' | 'control' | 'observe' | 'system'
  /** Shown in the mobile tab bar (max 5). */
  tab?: boolean
}

export const NAV_GROUPS = [
  { id: 'garden', label: 'Garden' },
  { id: 'control', label: 'Control' },
  { id: 'observe', label: 'Observe' },
] as const

export const navItems: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, group: 'garden', tab: true },
  { to: '/grow', label: 'Grow', icon: Leaf, group: 'garden' },
  { to: '/light', label: 'Light', icon: Sun, group: 'control', tab: true },
  { to: '/water', label: 'Water', icon: Droplets, group: 'control', tab: true },
  { to: '/schedule', label: 'Schedule', icon: CalendarClock, group: 'control', tab: true },
  { to: '/autopilot', label: 'Autopilot', icon: Wand2, group: 'control' },
  { to: '/cameras', label: 'Cameras', icon: Camera, group: 'observe' },
  { to: '/analysis', label: 'Analysis', icon: ScanEye, group: 'observe' },
  { to: '/sensors', label: 'Sensors', icon: Cpu, group: 'observe' },
  { to: '/alerts', label: 'Alerts', icon: Bell, group: 'system' },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'system', tab: true },
]
