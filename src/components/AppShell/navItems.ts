import { Bell, Camera, CalendarClock, Cpu, Droplets, LayoutDashboard, Leaf, ScanEye, Settings, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Shown in the mobile tab bar (max 5). */
  tab?: boolean
}

export const navItems: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, tab: true },
  { to: '/light', label: 'Light', icon: Sun, tab: true },
  { to: '/water', label: 'Water', icon: Droplets, tab: true },
  { to: '/schedule', label: 'Schedule', icon: CalendarClock, tab: true },
  { to: '/grow', label: 'Grow', icon: Leaf },
  { to: '/cameras', label: 'Cameras', icon: Camera },
  { to: '/analysis', label: 'Analysis', icon: ScanEye },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/sensors', label: 'Sensors', icon: Cpu },
  { to: '/settings', label: 'Settings', icon: Settings, tab: true },
]
