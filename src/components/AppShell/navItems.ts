import { Activity, Bell, Camera, Cpu, Droplets, LayoutDashboard, LayoutGrid, Leaf, ScanEye, Settings, Sun, Wand2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** The sidebar section it's listed under; `foot` sits at the bottom, outside the sections. */
  group: 'garden' | 'control' | 'observe' | 'system' | 'foot'
  /** Shown in the mobile tab bar (max 5). */
  tab?: boolean
}

export const NAV_GROUPS = [
  { id: 'garden', label: 'Garden' },
  { id: 'control', label: 'Control' },
  { id: 'observe', label: 'Observe' },
  { id: 'system', label: 'System' },
] as const

export const navItems: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, group: 'garden', tab: true },
  { to: '/grow', label: 'Grow', icon: Leaf, group: 'garden', tab: true },
  { to: '/plan', label: 'Plan', icon: LayoutGrid, group: 'garden' },
  { to: '/light', label: 'Light', icon: Sun, group: 'control', tab: true },
  { to: '/water', label: 'Water', icon: Droplets, group: 'control', tab: true },
  { to: '/autopilot', label: 'Autopilot', icon: Wand2, group: 'control' },
  { to: '/cameras', label: 'Cameras', icon: Camera, group: 'observe' },
  { to: '/analysis', label: 'Analysis', icon: ScanEye, group: 'observe' },
  // Health, History and Storage join Status here once they ship.
  { to: '/status', label: 'Status', icon: Activity, group: 'system' },
  { to: '/sensors', label: 'Sensors', icon: Cpu, group: 'system' },
  { to: '/alerts', label: 'Alerts', icon: Bell, group: 'foot' },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'foot', tab: true },
]
